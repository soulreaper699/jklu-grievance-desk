import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SQLITE_PATH = path.join(ROOT_DIR, "db", "grievance.sqlite");

// Load .env if present (handle optional UTF-8 BOM safely)
try {
  const envPath = path.join(ROOT_DIR, ".env");
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (k && process.env[k] === undefined) process.env[k] = v;
    }
  }
} catch {
  // Ignore .env load errors
}

export function sha256(message) {
  return crypto.createHash("sha256").update(message).digest("hex");
}

function createSqliteAdapter(sqliteDb) {
  const convertPlaceholders = (sql) => sql.replace(/\$(\d+)/g, "?");

  const query = async (sql, params = []) => {
    const trimmed = sql.trim().toUpperCase();
    const converted = convertPlaceholders(sql);
    const stmt = sqliteDb.prepare(converted);
    if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || /\bRETURNING\b/i.test(sql)) {
      const rows = stmt.all(...params);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...params);
    return { rows: [], rowCount: info.changes ?? 0, lastInsertRowid: info.lastInsertRowid };
  };

  const exec = async (sql) => {
    sqliteDb.exec(sql);
  };

  const transaction = async (fn) => {
    sqliteDb.exec("BEGIN");
    try {
      const res = await fn({ query });
      sqliteDb.exec("COMMIT");
      return res;
    } catch (err) {
      sqliteDb.exec("ROLLBACK");
      throw err;
    }
  };

  return { engine: "sqlite", query, exec, transaction };
}

function createPostgresAdapter(pool) {
  const query = async (sql, params = []) => pool.query(sql, params);
  const exec = async (sql) => pool.query(sql);
  const transaction = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await fn({ query: (sql, params = []) => client.query(sql, params) });
      await client.query("COMMIT");
      return res;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };
  return { engine: "postgres", query, exec, transaction };
}

const SQLITE_DDL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roles (
  role_id VARCHAR(20) PRIMARY KEY,
  role_name VARCHAR(50) NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS departments (
  dept_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dept_name VARCHAR(100) NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_name VARCHAR(100) NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  password_salt VARCHAR(64) NOT NULL DEFAULT '',
  role_id VARCHAR(20) NOT NULL,
  dept_id INTEGER NULL,
  roll_no VARCHAR(50) DEFAULT '',
  designation VARCHAR(150) DEFAULT '',
  auth_provider VARCHAR(30) NOT NULL DEFAULT 'email',
  verified INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT,
  FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS complaints (
  complaint_id VARCHAR(20) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  dept_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  assigned_faculty_id INTEGER NULL,
  stage_index INTEGER NOT NULL DEFAULT 0 CHECK (stage_index BETWEEN 0 AND 3),
  is_confidential INTEGER NOT NULL DEFAULT 0,
  is_escalated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE RESTRICT,
  FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE RESTRICT,
  FOREIGN KEY (student_id) REFERENCES users(user_id) ON DELETE RESTRICT,
  FOREIGN KEY (assigned_faculty_id) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id VARCHAR(20) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  uploaded_by INTEGER NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(user_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id VARCHAR(20) NOT NULL,
  user_id INTEGER NOT NULL,
  comment_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS upvotes (
  complaint_id VARCHAR(20) NOT NULL,
  user_id INTEGER NOT NULL,
  upvoted_at INTEGER NOT NULL,
  PRIMARY KEY (complaint_id, user_id),
  FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  notification_text TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_faculty ON complaints(assigned_faculty_id);
CREATE INDEX IF NOT EXISTS idx_complaints_dept ON complaints(dept_id);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category_id);
CREATE INDEX IF NOT EXISTS idx_comments_complaint ON comments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_attachments_complaint ON attachments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
`;

const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS roles (
  role_id VARCHAR(20) PRIMARY KEY,
  role_name VARCHAR(50) NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS departments (
  dept_id SERIAL PRIMARY KEY,
  dept_name VARCHAR(100) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  category_id SERIAL PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL UNIQUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  user_id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  password_salt VARCHAR(64) NOT NULL DEFAULT '',
  role_id VARCHAR(20) NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
  dept_id INTEGER NULL REFERENCES departments(dept_id) ON DELETE SET NULL,
  roll_no VARCHAR(50) DEFAULT '',
  designation VARCHAR(150) DEFAULT '',
  auth_provider VARCHAR(30) NOT NULL DEFAULT 'email',
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS complaints (
  complaint_id VARCHAR(20) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(category_id) ON DELETE RESTRICT,
  dept_id INTEGER NOT NULL REFERENCES departments(dept_id) ON DELETE RESTRICT,
  student_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  assigned_faculty_id INTEGER NULL REFERENCES users(user_id) ON DELETE SET NULL,
  stage_index INTEGER NOT NULL DEFAULT 0 CHECK (stage_index BETWEEN 0 AND 3),
  is_confidential BOOLEAN NOT NULL DEFAULT FALSE,
  is_escalated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  attachment_id SERIAL PRIMARY KEY,
  complaint_id VARCHAR(20) NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  uploaded_by INTEGER NULL REFERENCES users(user_id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  comment_id SERIAL PRIMARY KEY,
  complaint_id VARCHAR(20) NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  comment_text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS upvotes (
  complaint_id VARCHAR(20) NOT NULL REFERENCES complaints(complaint_id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  upvoted_at BIGINT NOT NULL,
  PRIMARY KEY (complaint_id, user_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  notification_text TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_faculty ON complaints(assigned_faculty_id);
CREATE INDEX IF NOT EXISTS idx_complaints_dept ON complaints(dept_id);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category_id);
CREATE INDEX IF NOT EXISTS idx_comments_complaint ON comments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_attachments_complaint ON attachments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
`;

async function seedIfEmpty(db) {
  const now = Date.now();
  const boolVal = (b) => (db.engine === "postgres" ? b : b ? 1 : 0);

  const roles = [
    ["student", "Student", "Can file complaints, track own grievances, upvote public complaints"],
    ["faculty", "Faculty / Department Head", "Can review assigned grievances, take actions, leave comments"],
    ["admin", "Registrar / Administrator", "Super-admin oversight, manage departments and categories"],
  ];
  for (const [id, name, desc] of roles) {
    await db.query(
      "INSERT INTO roles (role_id, role_name, description) VALUES ($1, $2, $3) ON CONFLICT (role_id) DO NOTHING",
      [id, name, desc]
    );
  }

  const depts = [
    "Computer Science",
    "Mechanical Engineering",
    "Electrical Engineering",
    "Hostel & Facilities",
    "Finance & Accounts",
    "Administration",
    "Internal Complaints Committee (ICC)",
  ];
  for (const name of depts) {
    await db.query(
      "INSERT INTO departments (dept_name, created_at) VALUES ($1, $2) ON CONFLICT (dept_name) DO NOTHING",
      [name, now]
    );
  }

  const cats = ["Academic", "Hostel", "Infrastructure", "Harassment", "Fees & Finance"];
  for (const name of cats) {
    await db.query(
      "INSERT INTO categories (category_name, created_at) VALUES ($1, $2) ON CONFLICT (category_name) DO NOTHING",
      [name, now]
    );
  }

  const { rows: deptRows } = await db.query("SELECT dept_id, dept_name FROM departments");
  const deptMap = Object.fromEntries(deptRows.map((r) => [r.dept_name, r.dept_id]));

  const studentHash = sha256("salt_jklu:student123");
  const facultyHash = sha256("salt_jklu:faculty123");
  const adminHash = sha256("salt_jklu:admin123");

  const seedUsers = [
    { name: "Chirag Negi", email: "chirag.negi@jklu.edu.in", role: "student", dept: "Computer Science", rollNo: "2024BTECH042", designation: "", hash: studentHash, provider: "microsoft_365" },
    { name: "Aisha Verma", email: "aisha.verma@jklu.edu.in", role: "student", dept: "Computer Science", rollNo: "2024BTECH015", designation: "", hash: studentHash, provider: "microsoft_365" },
    { name: "Rohan Mehta", email: "rohan.mehta@jklu.edu.in", role: "student", dept: "Mechanical Engineering", rollNo: "2024BTECH088", designation: "", hash: studentHash, provider: "email" },
    { name: "Dr. Priya Sharma", email: "priya.sharma@jklu.edu.in", role: "faculty", dept: "Computer Science", rollNo: "", designation: "HOD, Computer Science & Engineering", hash: facultyHash, provider: "microsoft_365" },
    { name: "Dr. Rajesh Singhal", email: "rajesh.singhal@jklu.edu.in", role: "faculty", dept: "Mechanical Engineering", rollNo: "", designation: "HOD, Mechanical Engineering", hash: facultyHash, provider: "microsoft_365" },
    { name: "Dr. Vikram Malhotra", email: "vikram.malhotra@jklu.edu.in", role: "faculty", dept: "Electrical Engineering", rollNo: "", designation: "HOD, Electrical Engineering", hash: facultyHash, provider: "microsoft_365" },
    { name: "Chief Warden (Prof. S. K. Verma)", email: "warden@jklu.edu.in", role: "faculty", dept: "Hostel & Facilities", rollNo: "", designation: "Hostel & Facilities Management", hash: facultyHash, provider: "microsoft_365" },
    { name: "Mr. Manoj Joshi", email: "manoj.joshi@jklu.edu.in", role: "faculty", dept: "Finance & Accounts", rollNo: "", designation: "Chief Finance & Accounts Officer", hash: facultyHash, provider: "microsoft_365" },
    { name: "Dr. Aman Kapoor", email: "aman.kapoor@jklu.edu.in", role: "faculty", dept: "Administration", rollNo: "", designation: "Dean of Student Affairs", hash: facultyHash, provider: "microsoft_365" },
    { name: "Prof. Sunita Gupta", email: "icc@jklu.edu.in", role: "faculty", dept: "Internal Complaints Committee (ICC)", rollNo: "", designation: "Presiding Officer, ICC", hash: facultyHash, provider: "microsoft_365" },
    { name: "Registrar's Office", email: "registrar@jklu.edu.in", role: "admin", dept: "Administration", rollNo: "", designation: "University Registrar", hash: adminHash, provider: "microsoft_365" },
  ];

  for (const u of seedUsers) {
    await db.query(
      `INSERT INTO users (full_name, email, password_hash, password_salt, role_id, dept_id, roll_no, designation, auth_provider, verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (email) DO NOTHING`,
      [u.name, u.email, u.hash, "salt_jklu", u.role, deptMap[u.dept] || null, u.rollNo, u.designation, u.provider, boolVal(true), now]
    );
  }

  const { rows: countRows } = await db.query("SELECT COUNT(*) AS cnt FROM complaints");
  if (Number(countRows[0]?.cnt || 0) > 0) return;

  const { rows: catRows } = await db.query("SELECT category_id, category_name FROM categories");
  const catMap = Object.fromEntries(catRows.map((r) => [r.category_name, r.category_id]));
  const { rows: userRows } = await db.query("SELECT user_id, email FROM users");
  const userMap = Object.fromEntries(userRows.map((r) => [r.email, r.user_id]));

  const seedComplaints = [
    {
      id: "CMP-1001",
      title: "Mess food quality has declined sharply",
      desc: "The hostel mess has been serving undercooked food for the past week. Several students reported stomach issues after dinner on Tuesday.",
      category: "Hostel",
      dept: "Hostel & Facilities",
      studentEmail: "chirag.negi@jklu.edu.in",
      facultyEmail: "warden@jklu.edu.in",
      stageIndex: 1,
      escalated: false,
      confidential: false,
      created: now - 1000 * 60 * 60 * 50,
      attachments: ["dinner_tray_photo.jpg"],
      upvotes: ["aisha.verma@jklu.edu.in", "rohan.mehta@jklu.edu.in"],
      comments: [
        { email: "chirag.negi@jklu.edu.in", text: "Attaching photos of yesterday's dinner for reference.", when: now - 1000 * 60 * 60 * 48 },
        { email: "warden@jklu.edu.in", text: "Forwarded to the mess contractor for a response by Friday.", when: now - 1000 * 60 * 60 * 20 },
      ],
    },
    {
      id: "CMP-1002",
      title: "Lab systems in CS-204 won't boot",
      desc: "Six machines in the second-floor CS lab have been stuck at a boot loop since Monday, affecting the DSA practical schedule.",
      category: "Infrastructure",
      dept: "Computer Science",
      studentEmail: "chirag.negi@jklu.edu.in",
      facultyEmail: "priya.sharma@jklu.edu.in",
      stageIndex: 3,
      escalated: false,
      confidential: false,
      created: now - 1000 * 60 * 60 * 24 * 6,
      attachments: [],
      upvotes: [],
      comments: [
        { email: "priya.sharma@jklu.edu.in", text: "IT replaced the faulty SSDs. Please confirm all six are working now.", when: now - 1000 * 60 * 60 * 24 * 2 },
        { email: "chirag.negi@jklu.edu.in", text: "Confirmed, all machines boot fine now. Thank you.", when: now - 1000 * 60 * 60 * 24 * 1 },
      ],
    },
    {
      id: "CMP-1003",
      title: "Inappropriate remarks from a senior during group project review",
      desc: "During a project review, a senior student made repeated inappropriate comments that made me uncomfortable. I'd like this handled discreetly.",
      category: "Harassment",
      dept: "Internal Complaints Committee (ICC)",
      studentEmail: "aisha.verma@jklu.edu.in",
      facultyEmail: "icc@jklu.edu.in",
      stageIndex: 1,
      escalated: false,
      confidential: true,
      created: now - 1000 * 60 * 60 * 30,
      attachments: [],
      upvotes: [],
      comments: [
        { email: "icc@jklu.edu.in", text: "Received. This will only be visible to me and you while it's under review.", when: now - 1000 * 60 * 60 * 28 },
      ],
    },
    {
      id: "CMP-1004",
      title: "Library central AC not functioning during mid-term prep",
      desc: "The 2nd floor silent reading zone temperature has been consistently over 32°C due to non-functioning AC ducts. Makes studying for mid-terms unbearable.",
      category: "Infrastructure",
      dept: "Administration",
      studentEmail: "rohan.mehta@jklu.edu.in",
      facultyEmail: "aman.kapoor@jklu.edu.in",
      stageIndex: 1,
      escalated: false,
      confidential: false,
      created: now - 1000 * 60 * 60 * 18,
      attachments: [],
      upvotes: ["aisha.verma@jklu.edu.in", "chirag.negi@jklu.edu.in"],
      comments: [
        { email: "rohan.mehta@jklu.edu.in", text: "Reported to facilities desk yesterday, awaiting technician visit.", when: now - 1000 * 60 * 60 * 16 },
      ],
    },
    {
      id: "CMP-1005",
      title: "Hostel Block B & C Wi-Fi drops every 15 minutes",
      desc: "Repeated gateway disconnects make attending online quizzes and lab submissions extremely frustrating during evening hours.",
      category: "Hostel",
      dept: "Hostel & Facilities",
      studentEmail: "aisha.verma@jklu.edu.in",
      facultyEmail: "warden@jklu.edu.in",
      stageIndex: 0,
      escalated: false,
      confidential: false,
      created: now - 1000 * 60 * 60 * 8,
      attachments: [],
      upvotes: ["rohan.mehta@jklu.edu.in"],
      comments: [],
    },
  ];

  for (const c of seedComplaints) {
    await db.query(
      `INSERT INTO complaints (complaint_id, title, description, category_id, dept_id, student_id, assigned_faculty_id, stage_index, is_confidential, is_escalated, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (complaint_id) DO NOTHING`,
      [
        c.id,
        c.title,
        c.desc,
        catMap[c.category],
        deptMap[c.dept],
        userMap[c.studentEmail],
        userMap[c.facultyEmail] || null,
        c.stageIndex,
        boolVal(c.confidential),
        boolVal(c.escalated),
        c.created,
        c.created,
      ]
    );

    for (const fileName of c.attachments) {
      await db.query(
        "INSERT INTO attachments (complaint_id, file_name, uploaded_by, created_at) VALUES ($1, $2, $3, $4)",
        [c.id, fileName, userMap[c.studentEmail], c.created]
      );
    }

    for (const voterEmail of c.upvotes) {
      await db.query(
        "INSERT INTO upvotes (complaint_id, user_id, upvoted_at) VALUES ($1, $2, $3) ON CONFLICT (complaint_id, user_id) DO NOTHING",
        [c.id, userMap[voterEmail], c.created + 1000 * 60 * 30]
      );
    }

    for (const cm of c.comments) {
      await db.query(
        "INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)",
        [c.id, userMap[cm.email], cm.text, cm.when]
      );
    }
  }

  const seedNotifications = [
    { email: "warden@jklu.edu.in", text: "New complaint CMP-1001 was routed to you.", when: now - 1000 * 60 * 60 * 50 },
    { email: "chirag.negi@jklu.edu.in", text: "Chief Warden (Prof. S. K. Verma) commented on CMP-1001.", when: now - 1000 * 60 * 60 * 20 },
    { email: "chirag.negi@jklu.edu.in", text: "CMP-1002 was marked Resolved.", when: now - 1000 * 60 * 60 * 24 * 2 },
  ];
  for (const n of seedNotifications) {
    await db.query(
      "INSERT INTO notifications (user_id, notification_text, is_read, created_at) VALUES ($1, $2, $3, $4)",
      [userMap[n.email], n.text, boolVal(false), n.when]
    );
  }
}

let dbPromise = null;

export async function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = (async () => {
    const databaseUrl = (process.env.DATABASE_URL || "").trim();
    if (databaseUrl) {
      const { default: pg } = await import("pg");
      const useSsl = !/localhost|127\.0\.0\.1/i.test(databaseUrl);
      const pool = new pg.Pool({
        connectionString: databaseUrl,
        ssl: useSsl ? { rejectUnauthorized: false } : false,
      });
      const adapter = createPostgresAdapter(pool);
      await adapter.exec(POSTGRES_DDL);
      await seedIfEmpty(adapter);
      console.log("[db] Connected to PostgreSQL (3NF relational schema ready)");
      return adapter;
    }

    fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const sqliteDb = new DatabaseSync(SQLITE_PATH);
    const adapter = createSqliteAdapter(sqliteDb);
    await adapter.exec(SQLITE_DDL);
    await seedIfEmpty(adapter);
    console.log(`[db] Connected to SQLite (${SQLITE_PATH})`);
    return adapter;
  })();
  return dbPromise;
}


import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { getDb, sha256 } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT_DIR, "dist");

const STAGES = ["Submitted", "In Review", "Action Taken", "Resolved"];

const app = express();
app.use(express.json({ limit: "2mb" }));

async function fetchBootstrap(db) {
  const [deptsRes, catsRes, usersRes, complaintsRes, commentsRes, attachmentsRes, upvotesRes, notifsRes] =
    await Promise.all([
      db.query("SELECT dept_name FROM departments ORDER BY dept_id ASC"),
      db.query("SELECT category_name FROM categories ORDER BY category_id ASC"),
      db.query(
        `SELECT u.user_id, u.full_name, u.email, u.role_id, d.dept_name, u.roll_no, u.designation, u.auth_provider, u.verified, u.created_at
         FROM users u
         LEFT JOIN departments d ON u.dept_id = d.dept_id
         ORDER BY u.user_id ASC`
      ),
      db.query(
        `SELECT c.complaint_id, c.title, c.description, cat.category_name, d.dept_name,
                s.full_name AS student_name, s.email AS student_email,
                f.full_name AS faculty_name, f.email AS faculty_email,
                c.stage_index, c.is_confidential, c.is_escalated, c.created_at, c.updated_at
         FROM complaints c
         JOIN categories cat ON c.category_id = cat.category_id
         JOIN departments d ON c.dept_id = d.dept_id
         JOIN users s ON c.student_id = s.user_id
         LEFT JOIN users f ON c.assigned_faculty_id = f.user_id
         ORDER BY c.created_at DESC`
      ),
      db.query(
        `SELECT cm.complaint_id, u.full_name AS author_name, cm.comment_text, cm.created_at
         FROM comments cm
         JOIN users u ON cm.user_id = u.user_id
         ORDER BY cm.created_at ASC, cm.comment_id ASC`
      ),
      db.query(
        `SELECT complaint_id, file_name
         FROM attachments
         ORDER BY attachment_id ASC`
      ),
      db.query(
        `SELECT up.complaint_id, u.full_name AS voter_name
         FROM upvotes up
         JOIN users u ON up.user_id = u.user_id
         ORDER BY up.upvoted_at ASC`
      ),
      db.query(
        `SELECT u.full_name AS for_user, u.email AS for_email, n.notification_text, n.created_at
         FROM notifications n
         JOIN users u ON n.user_id = u.user_id
         ORDER BY n.created_at DESC, n.notification_id DESC
         LIMIT 200`
      ),
    ]);

  const commentsByCmp = {};
  for (const row of commentsRes.rows) {
    (commentsByCmp[row.complaint_id] ||= []).push({
      who: row.author_name,
      text: row.comment_text,
      when: Number(row.created_at),
    });
  }

  const attachmentsByCmp = {};
  for (const row of attachmentsRes.rows) {
    (attachmentsByCmp[row.complaint_id] ||= []).push(row.file_name);
  }

  const upvotesByCmp = {};
  for (const row of upvotesRes.rows) {
    (upvotesByCmp[row.complaint_id] ||= []).push(row.voter_name);
  }

  let maxNum = 1005;
  const complaints = complaintsRes.rows.map((c) => {
    const num = Number(String(c.complaint_id).replace(/^CMP-/, "")) || 0;
    if (num > maxNum) maxNum = num;
    return {
      id: c.complaint_id,
      title: c.title,
      desc: c.description,
      category: c.category_name,
      department: c.dept_name,
      student: c.student_name,
      studentEmail: c.student_email,
      faculty: c.faculty_name || "Dr. Aman Kapoor",
      facultyEmail: c.faculty_email || "aman.kapoor@jklu.edu.in",
      stageIndex: Number(c.stage_index),
      escalated: Boolean(c.is_escalated),
      confidential: Boolean(c.is_confidential),
      created: Number(c.created_at),
      comments: commentsByCmp[c.complaint_id] || [],
      attachments: attachmentsByCmp[c.complaint_id] || [],
      upvotes: upvotesByCmp[c.complaint_id] || [],
    };
  });

  const users = usersRes.rows.map((u) => ({
    id: `usr_${u.user_id}`,
    userId: u.user_id,
    name: u.full_name,
    email: u.email,
    role: u.role_id,
    dept: u.dept_name || "Computer Science",
    rollNo: u.roll_no || "",
    designation: u.designation || "",
    authProvider: u.auth_provider || "email",
    verified: Boolean(u.verified),
    createdAt: Number(u.created_at),
  }));

  const notifications = notifsRes.rows.map((n) => ({
    forUser: n.for_user,
    forEmail: n.for_email,
    text: n.notification_text,
    when: Number(n.created_at),
  }));

  return {
    dbEngine: db.engine,
    departments: deptsRes.rows.map((d) => d.dept_name),
    categories: catsRes.rows.map((c) => c.category_name),
    users,
    complaints,
    notifications,
    nextId: maxNum + 1,
  };
}

function formatUserRow(u) {
  return {
    id: `usr_${u.user_id}`,
    userId: u.user_id,
    name: u.full_name,
    email: u.email,
    role: u.role_id,
    dept: u.dept_name || "Computer Science",
    rollNo: u.roll_no || "",
    designation: u.designation || "",
    authProvider: u.auth_provider || "email",
    verified: Boolean(u.verified),
    createdAt: Number(u.created_at),
  };
}

async function resolveUserByIdentifier(db, identifier) {
  const clean = String(identifier || "").trim().toLowerCase();
  if (!clean) return null;
  const { rows } = await db.query(
    `SELECT u.*, d.dept_name
     FROM users u
     LEFT JOIN departments d ON u.dept_id = d.dept_id
     WHERE LOWER(u.email) = $1 OR LOWER(u.full_name) = $1
     LIMIT 1`,
    [clean]
  );
  return rows[0] || null;
}

async function createNotification(tx, userId, text, when = Date.now()) {
  if (!userId) return;
  const isRead = false;
  await tx.query(
    "INSERT INTO notifications (user_id, notification_text, is_read, created_at) VALUES ($1, $2, $3, $4)",
    [userId, text, tx.engine === "postgres" ? isRead : 0, when]
  );
}

app.get("/api/health", async (_req, res) => {
  try {
    const db = await getDb();
    await db.query("SELECT 1");
    res.json({ ok: true, engine: db.engine });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/bootstrap", async (_req, res) => {
  try {
    const db = await getDb();
    const payload = await fetchBootstrap(db);
    res.json(payload);
  } catch (err) {
    console.error("GET /api/bootstrap failed:", err);
    res.status(500).json({ error: "Database bootstrap failed" });
  }
});

app.get("/api/analytics", async (_req, res) => {
  try {
    const db = await getDb();
    const [deptStats, facultyStats] = await Promise.all([
      db.query(
        `SELECT d.dept_name,
                COUNT(c.complaint_id) AS total_complaints,
                SUM(CASE WHEN c.stage_index = 3 THEN 1 ELSE 0 END) AS resolved_count
         FROM departments d
         LEFT JOIN complaints c ON d.dept_id = c.dept_id
         GROUP BY d.dept_id, d.dept_name
         ORDER BY total_complaints DESC`
      ),
      db.query(
        `SELECT u.full_name AS faculty_name, d.dept_name,
                COUNT(c.complaint_id) AS pending_complaints
         FROM users u
         JOIN departments d ON u.dept_id = d.dept_id
         LEFT JOIN complaints c ON u.user_id = c.assigned_faculty_id AND c.stage_index < 3
         WHERE u.role_id = 'faculty'
         GROUP BY u.user_id, u.full_name, d.dept_name
         ORDER BY pending_complaints DESC`
      ),
    ]);
    res.json({
      engine: db.engine,
      departmentStats: deptStats.rows,
      facultyWorkload: facultyStats.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const db = await getDb();
    const emailOrName = String(req.body?.emailOrName || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!emailOrName || !password) {
      return res.status(400).json({ error: "Enter your university email and password." });
    }
    const user = await resolveUserByIdentifier(db, emailOrName);
    if (!user) {
      return res.status(401).json({ error: `No account found for "${emailOrName}". Check your email or Sign Up.` });
    }
    const computedHash = sha256(`${user.password_salt}:${password}`);
    const legacyMatch =
      (user.role_id === "student" && password === "student123") ||
      (user.role_id === "faculty" && password === "faculty123") ||
      (user.role_id === "admin" && password === "admin123");

    if (user.password_hash !== computedHash && !legacyMatch) {
      return res.status(401).json({ error: "Incorrect password." });
    }
    res.json({ user: formatUserRow(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/signup", async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "student");
    const deptName = role === "student" ? "Computer Science" : String(req.body?.dept || "Computer Science");
    const rollNo = String(req.body?.rollNo || "").trim();
    const password = String(req.body?.password || "");

    if (!name || name.length < 2) return res.status(400).json({ error: "Please enter your full official name." });
    if (!email.endsWith("@jklu.edu.in")) return res.status(400).json({ error: "Email must end with @jklu.edu.in" });
    if (!["student", "faculty", "admin"].includes(role)) return res.status(400).json({ error: "Invalid role." });
    if (role === "student" && !rollNo) return res.status(400).json({ error: "Roll number is required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await resolveUserByIdentifier(db, email);
    if (existing) return res.status(409).json({ error: "This email is already registered. Please Sign In instead." });

    const { rows: deptRows } = await db.query("SELECT dept_id FROM departments WHERE dept_name = $1 LIMIT 1", [deptName]);
    const deptId = deptRows[0]?.dept_id || null;

    const salt = "s_" + crypto.randomBytes(6).toString("hex");
    const passwordHash = sha256(`${salt}:${password}`);
    const now = Date.now();
    const verifiedVal = db.engine === "postgres" ? true : 1;

    await db.query(
      `INSERT INTO users (full_name, email, password_hash, password_salt, role_id, dept_id, roll_no, designation, auth_provider, verified, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '', 'email', $8, $9)`,
      [name, email, passwordHash, salt, role, deptId, rollNo, verifiedVal, now]
    );
    const created = await resolveUserByIdentifier(db, email);
    res.status(201).json({ user: formatUserRow(created) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/microsoft", async (req, res) => {
  try {
    const db = await getDb();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const name = String(req.body?.name || "").trim() || (email ? email.split("@")[0] : "Microsoft User");
    if (!email) return res.status(400).json({ error: "Microsoft account email is required." });

    let user = await resolveUserByIdentifier(db, email);
    if (!user) {
      const { rows: deptRows } = await db.query(
        "SELECT dept_id FROM departments WHERE dept_name = 'Computer Science' LIMIT 1"
      );
      const deptId = deptRows[0]?.dept_id || null;
      const verifiedVal = db.engine === "postgres" ? true : 1;
      await db.query(
        `INSERT INTO users (full_name, email, password_hash, password_salt, role_id, dept_id, roll_no, designation, auth_provider, verified, created_at)
         VALUES ($1, $2, '', '', 'student', $3, '', '', 'microsoft_365', $4, $5)`,
        [name, email, deptId, verifiedVal, Date.now()]
      );
      user = await resolveUserByIdentifier(db, email);
    } else {
      await db.query("UPDATE users SET auth_provider = 'microsoft_365' WHERE user_id = $1", [user.user_id]);
      user.auth_provider = "microsoft_365";
    }

    res.json({ user: formatUserRow(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/complaints", async (req, res) => {
  try {
    const db = await getDb();
    const title = String(req.body?.title || "").trim();
    const desc = String(req.body?.desc || "").trim();
    const category = String(req.body?.category || "").trim();
    const department = String(req.body?.department || "").trim();
    const studentEmail = String(req.body?.studentEmail || "").trim().toLowerCase();
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const confidential = category === "Harassment" ? true : Boolean(req.body?.confidential);

    if (!title || desc.length < 10) {
      return res.status(400).json({ error: "Title and a description of at least 10 characters are required." });
    }

    const result = await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows: catRows } = await tx.query("SELECT category_id FROM categories WHERE category_name = $1", [category]);
      const { rows: deptRows } = await tx.query("SELECT dept_id FROM departments WHERE dept_name = $1", [department]);
      if (!catRows[0] || !deptRows[0]) {
        throw Object.assign(new Error("Invalid category or department"), { status: 400 });
      }
      const student = await resolveUserByIdentifier(tx, studentEmail || req.body?.student);
      if (!student) {
        throw Object.assign(new Error("Student account not found"), { status: 400 });
      }

      const { rows: facRows } = await tx.query(
        `SELECT user_id, full_name, email FROM users WHERE role_id = 'faculty' AND dept_id = $1 ORDER BY user_id ASC LIMIT 1`,
        [deptRows[0].dept_id]
      );
      let faculty = facRows[0];
      if (!faculty) {
        const { rows: fallbackRows } = await tx.query(
          `SELECT u.user_id, u.full_name, u.email FROM users u JOIN departments d ON u.dept_id = d.dept_id
           WHERE u.role_id = 'faculty' AND d.dept_name = 'Administration' LIMIT 1`
        );
        faculty = fallbackRows[0] || null;
      }

      const { rows: existingIds } = await tx.query("SELECT complaint_id FROM complaints");
      let maxNum = 1005;
      for (const r of existingIds) {
        const n = Number(String(r.complaint_id).replace(/^CMP-/, "")) || 0;
        if (n > maxNum) maxNum = n;
      }
      const complaintId = `CMP-${maxNum + 1}`;
      const now = Date.now();
      const confVal = db.engine === "postgres" ? confidential : confidential ? 1 : 0;
      const escVal = db.engine === "postgres" ? false : 0;

      await tx.query(
        `INSERT INTO complaints (complaint_id, title, description, category_id, dept_id, student_id, assigned_faculty_id, stage_index, is_confidential, is_escalated, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
        [
          complaintId,
          title,
          desc,
          catRows[0].category_id,
          deptRows[0].dept_id,
          student.user_id,
          faculty ? faculty.user_id : null,
          confVal,
          escVal,
          now,
          now,
        ]
      );

      for (const fileName of attachments) {
        const cleanFile = String(fileName || "").trim();
        if (cleanFile) {
          await tx.query(
            "INSERT INTO attachments (complaint_id, file_name, uploaded_by, created_at) VALUES ($1, $2, $3, $4)",
            [complaintId, cleanFile, student.user_id, now]
          );
        }
      }

      if (faculty) {
        await createNotification(tx, faculty.user_id, `New complaint ${complaintId} was routed to you (${department}).`, now);
      }

      return { complaintId, facultyName: faculty?.full_name || "Administration" };
    });

    const bootstrap = await fetchBootstrap(db);
    res.status(201).json({ ...result, bootstrap });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/advance", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const actorEmail = String(req.body?.actorEmail || req.body?.actorName || "");

    await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      if (c.is_escalated || Number(c.stage_index) >= STAGES.length - 1) {
        throw Object.assign(new Error("Complaint cannot be advanced further"), { status: 400 });
      }
      const nextStage = Number(c.stage_index) + 1;
      const actor = (await resolveUserByIdentifier(tx, actorEmail)) || { user_id: c.assigned_faculty_id };
      const now = Date.now();
      await tx.query("UPDATE complaints SET stage_index = $1, updated_at = $2 WHERE complaint_id = $3", [nextStage, now, id]);
      await tx.query("INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        actor.user_id,
        `Moved to "${STAGES[nextStage]}".`,
        now,
      ]);
      await createNotification(tx, c.student_id, `${id} was marked "${STAGES[nextStage]}".`, now);
    });

    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/escalate", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const actorEmail = String(req.body?.actorEmail || req.body?.actorName || "");

    await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      const actor = (await resolveUserByIdentifier(tx, actorEmail)) || { user_id: c.assigned_faculty_id, full_name: "Faculty" };
      const now = Date.now();
      const escVal = db.engine === "postgres" ? true : 1;
      await tx.query("UPDATE complaints SET is_escalated = $1, updated_at = $2 WHERE complaint_id = $3", [escVal, now, id]);
      await tx.query("INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        actor.user_id,
        "Escalated this complaint to the department head.",
        now,
      ]);
      await createNotification(tx, c.student_id, `${id} was escalated to the department head.`, now);
      const { rows: admins } = await tx.query("SELECT user_id FROM users WHERE role_id = 'admin' LIMIT 1");
      if (admins[0]) {
        await createNotification(tx, admins[0].user_id, `${id} was escalated by ${actor.full_name}.`, now);
      }
    });

    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/clear-escalation", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const actorEmail = String(req.body?.actorEmail || req.body?.actorName || "");

    await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      const actor = (await resolveUserByIdentifier(tx, actorEmail)) || { user_id: c.assigned_faculty_id };
      const now = Date.now();
      const escVal = db.engine === "postgres" ? false : 0;
      await tx.query("UPDATE complaints SET is_escalated = $1, updated_at = $2 WHERE complaint_id = $3", [escVal, now, id]);
      await tx.query("INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        actor.user_id,
        "Escalation cleared, resuming normal review.",
        now,
      ]);
      await createNotification(tx, c.student_id, `${id} escalation was cleared; review has resumed.`, now);
    });

    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/upvote", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const userIdentifier = String(req.body?.userEmail || req.body?.userName || "");

    const added = await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      if (c.is_confidential) throw Object.assign(new Error("Cannot upvote confidential complaints"), { status: 400 });
      const user = await resolveUserByIdentifier(tx, userIdentifier);
      if (!user) throw Object.assign(new Error("User not found"), { status: 400 });

      const { rows: existing } = await tx.query(
        "SELECT 1 FROM upvotes WHERE complaint_id = $1 AND user_id = $2",
        [id, user.user_id]
      );
      if (existing.length > 0) {
        await tx.query("DELETE FROM upvotes WHERE complaint_id = $1 AND user_id = $2", [id, user.user_id]);
        return false;
      }
      const now = Date.now();
      await tx.query("INSERT INTO upvotes (complaint_id, user_id, upvoted_at) VALUES ($1, $2, $3)", [
        id,
        user.user_id,
        now,
      ]);
      if (c.student_id !== user.user_id) {
        await createNotification(tx, c.student_id, `${user.full_name} upvoted your complaint ${id}: "${c.title}".`, now);
      }
      return true;
    });

    res.json({ added, bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/comments", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const text = String(req.body?.text || "").trim();
    const userIdentifier = String(req.body?.userEmail || req.body?.userName || "");
    if (!text) return res.status(400).json({ error: "Comment text is required." });

    await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      const user = await resolveUserByIdentifier(tx, userIdentifier);
      if (!user) throw Object.assign(new Error("User not found"), { status: 400 });

      const now = Date.now();
      await tx.query("INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        user.user_id,
        text,
        now,
      ]);
      const recipientId = user.user_id === c.student_id ? c.assigned_faculty_id : c.student_id;
      await createNotification(tx, recipientId, `${user.full_name} commented on ${id}.`, now);
    });

    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/complaints/:id/attachments", async (req, res) => {
  try {
    const db = await getDb();
    const id = req.params.id;
    const fileName = String(req.body?.fileName || "").trim();
    const userIdentifier = String(req.body?.userEmail || req.body?.userName || "");
    if (!fileName) return res.status(400).json({ error: "Attachment filename is required." });

    await db.transaction(async (tx) => {
      tx.engine = db.engine;
      const { rows } = await tx.query("SELECT * FROM complaints WHERE complaint_id = $1", [id]);
      const c = rows[0];
      if (!c) throw Object.assign(new Error("Complaint not found"), { status: 404 });
      const user = await resolveUserByIdentifier(tx, userIdentifier);
      if (!user) throw Object.assign(new Error("User not found"), { status: 400 });

      const now = Date.now();
      await tx.query(
        "INSERT INTO attachments (complaint_id, file_name, uploaded_by, created_at) VALUES ($1, $2, $3, $4)",
        [id, fileName, user.user_id, now]
      );
      await tx.query("INSERT INTO comments (complaint_id, user_id, comment_text, created_at) VALUES ($1, $2, $3, $4)", [
        id,
        user.user_id,
        `Attached a file: ${fileName}`,
        now,
      ]);
      const recipientId = user.user_id === c.student_id ? c.assigned_faculty_id : c.student_id;
      await createNotification(tx, recipientId, `${id} got a new attachment from ${user.full_name}.`, now);
    });

    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/departments", async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Department name is required." });
    const { rows: existing } = await db.query("SELECT 1 FROM departments WHERE dept_name = $1", [name]);
    if (existing.length) return res.status(409).json({ error: "Already exists" });
    await db.query("INSERT INTO departments (dept_name, created_at) VALUES ($1, $2)", [name, Date.now()]);
    res.status(201).json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/departments/:name", async (req, res) => {
  try {
    const db = await getDb();
    const name = req.params.name;
    const { rows: inUse } = await db.query(
      "SELECT 1 FROM complaints c JOIN departments d ON c.dept_id = d.dept_id WHERE d.dept_name = $1 LIMIT 1",
      [name]
    );
    if (inUse.length) return res.status(409).json({ error: "Department is in use by existing complaints." });
    await db.query("DELETE FROM departments WHERE dept_name = $1", [name]);
    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/categories", async (req, res) => {
  try {
    const db = await getDb();
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Category name is required." });
    const { rows: existing } = await db.query("SELECT 1 FROM categories WHERE category_name = $1", [name]);
    if (existing.length) return res.status(409).json({ error: "Already exists" });
    await db.query("INSERT INTO categories (category_name, created_at) VALUES ($1, $2)", [name, Date.now()]);
    res.status(201).json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/categories/:name", async (req, res) => {
  try {
    const db = await getDb();
    const name = req.params.name;
    const { rows: inUse } = await db.query(
      "SELECT 1 FROM complaints c JOIN categories cat ON c.category_id = cat.category_id WHERE cat.category_name = $1 LIMIT 1",
      [name]
    );
    if (inUse.length) return res.status(409).json({ error: "Category is in use by existing complaints." });
    await db.query("DELETE FROM categories WHERE category_name = $1", [name]);
    res.json({ bootstrap: await fetchBootstrap(db) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve built frontend in production
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, "index.html"));
  });
}

const PORT = parseInt(process.env.API_PORT || process.env.PORT || "8443", 10);

getDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[server] JKLU Grievance Desk API listening on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[server] Failed to initialize database:", err);
    process.exit(1);
  });


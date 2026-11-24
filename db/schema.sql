-- ============================================================================
-- JK LAKSHMIPAT UNIVERSITY - GRIEVANCE DESK PORTAL
-- Relational Database Management System (DBMS) Schema
-- Normalized to 3NF (Third Normal Form) with Foreign Key Integrity
-- Compatible with MySQL 8.0+ and SQLite 3
-- ============================================================================

-- 1. DEPARTMENTS TABLE
CREATE TABLE IF NOT EXISTS departments (
    dept_id INTEGER PRIMARY KEY AUTOINCREMENT,
    dept_name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. CATEGORIES TABLE
CREATE TABLE IF NOT EXISTS categories (
    category_id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_name VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. ROLES TABLE
CREATE TABLE IF NOT EXISTS roles (
    role_id VARCHAR(20) PRIMARY KEY,
    role_name VARCHAR(50) NOT NULL,
    description TEXT
);

-- 4. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role_id VARCHAR(20) NOT NULL,
    dept_id INTEGER NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(role_id) ON DELETE RESTRICT,
    FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE SET NULL
);

-- 5. COMPLAINTS TABLE (Core Entity)
CREATE TABLE IF NOT EXISTS complaints (
    complaint_id VARCHAR(20) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    dept_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    assigned_faculty_id INTEGER NULL,
    stage_index INTEGER DEFAULT 0 CHECK (stage_index BETWEEN 0 AND 3), 
    -- 0: Submitted, 1: In Review, 2: Action Taken, 3: Resolved
    is_confidential BOOLEAN DEFAULT 0,
    is_escalated BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE RESTRICT,
    FOREIGN KEY (dept_id) REFERENCES departments(dept_id) ON DELETE RESTRICT,
    FOREIGN KEY (student_id) REFERENCES users(user_id) ON DELETE RESTRICT,
    FOREIGN KEY (assigned_faculty_id) REFERENCES users(user_id) ON DELETE SET NULL
);

-- 6. COMMENTS / AUDIT TRAIL TABLE
CREATE TABLE IF NOT EXISTS comments (
    comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id VARCHAR(20) NOT NULL,
    user_id INTEGER NOT NULL,
    comment_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

-- 7. UPVOTES TABLE (Composite Primary Key)
CREATE TABLE IF NOT EXISTS upvotes (
    complaint_id VARCHAR(20) NOT NULL,
    user_id INTEGER NOT NULL,
    upvoted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (complaint_id, user_id),
    FOREIGN KEY (complaint_id) REFERENCES complaints(complaint_id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 8. NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS notifications (
    notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    notification_text TEXT NOT NULL,
    is_read BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- ============================================================================
-- INDEXES FOR QUERY OPTIMIZATION
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
CREATE INDEX IF NOT EXISTS idx_complaints_faculty ON complaints(assigned_faculty_id);
CREATE INDEX IF NOT EXISTS idx_complaints_dept ON complaints(dept_id);
CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category_id);
CREATE INDEX IF NOT EXISTS idx_complaints_stage ON complaints(stage_index);
CREATE INDEX IF NOT EXISTS idx_comments_complaint ON comments(complaint_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- ============================================================================
-- SEED DATA (Corresponds with Portal Frontend seed data)
-- ============================================================================

-- Roles
INSERT OR IGNORE INTO roles (role_id, role_name, description) VALUES
('student', 'Student', 'Can file complaints, track own grievances, upvote public complaints'),
('faculty', 'Faculty / Department Head', 'Can review assigned grievances, take actions, leave comments'),
('admin', 'Registrar / Administrator', 'Super-admin oversight, manage departments and categories');

-- Departments
INSERT OR IGNORE INTO departments (dept_id, dept_name) VALUES
(1, 'Computer Science'),
(2, 'Mechanical Engineering'),
(3, 'Electrical Engineering'),
(4, 'Hostel & Facilities'),
(5, 'Finance & Accounts'),
(6, 'Administration'),
(7, 'Internal Complaints Committee (ICC)');

-- Categories
INSERT OR IGNORE INTO categories (category_id, category_name) VALUES
(1, 'Academic'),
(2, 'Hostel'),
(3, 'Infrastructure'),
(4, 'Harassment'),
(5, 'Fees & Finance');

-- Users
INSERT OR IGNORE INTO users (user_id, full_name, email, password_hash, role_id, dept_id) VALUES
(1, 'Chirag Negi', 'chirag.negi@jklu.edu.in', 'student123', 'student', NULL),
(2, 'Aisha Verma', 'aisha.verma@jklu.edu.in', 'student123', 'student', NULL),
(3, 'Rohan Mehta', 'rohan.mehta@jklu.edu.in', 'student123', 'student', NULL),
(4, 'Dr. Priya Sharma', 'priya.sharma@jklu.edu.in', 'faculty123', 'faculty', 1),
(5, 'Dr. Rajesh Singhal', 'rajesh.singhal@jklu.edu.in', 'faculty123', 'faculty', 2),
(6, 'Dr. Vikram Malhotra', 'vikram.malhotra@jklu.edu.in', 'faculty123', 'faculty', 3),
(7, 'Chief Warden (Prof. S. K. Verma)', 'warden@jklu.edu.in', 'faculty123', 'faculty', 4),
(8, 'Mr. Manoj Joshi', 'accounts@jklu.edu.in', 'faculty123', 'faculty', 5),
(9, 'Dr. Aman Kapoor', 'aman.kapoor@jklu.edu.in', 'faculty123', 'faculty', 6),
(10, 'Prof. Sunita Gupta', 'icc@jklu.edu.in', 'faculty123', 'faculty', 7),
(11, 'Registrar''s Office', 'registrar@jklu.edu.in', 'admin123', 'admin', 6);

-- Seed Complaints
INSERT OR IGNORE INTO complaints (complaint_id, title, description, category_id, dept_id, student_id, assigned_faculty_id, stage_index, is_confidential, is_escalated) VALUES
('CMP-1001', 'Mess food quality has declined sharply', 'The hostel mess has been serving undercooked food for the past week. Several students reported stomach issues after dinner on Tuesday.', 2, 5, 1, 5, 1, 0, 0),
('CMP-1002', 'Library Wi-Fi disconnects repeatedly on 2nd floor', 'The access point near the reference section keeps dropping connections every 5-10 minutes, making coursework study difficult.', 3, 4, 2, 4, 3, 0, 0),
('CMP-1003', 'Course registration portal timed out during elective pick', 'Elective seat allocation showed an internal server error 500 when batch CS-2024 submitted forms at 10:00 AM.', 1, 1, 3, 4, 2, 0, 1);

-- Seed Comments
INSERT OR IGNORE INTO comments (complaint_id, user_id, comment_text) VALUES
('CMP-1001', 1, 'Attaching photos of yesterday''s dinner for reference.'),
('CMP-1001', 5, 'Forwarded to the mess contractor for an immediate audit by Friday.'),
('CMP-1002', 4, 'IT team replaced the faulty repeater on 2nd floor. Verified operational.'),
('CMP-1003', 4, 'Database transaction pool size increased; elective picks re-opened for CS-2024.');

-- Seed Upvotes
INSERT OR IGNORE INTO upvotes (complaint_id, user_id) VALUES
('CMP-1001', 2),
('CMP-1001', 3),
('CMP-1002', 1);

-- Seed Notifications
INSERT OR IGNORE INTO notifications (user_id, notification_text) VALUES
(5, 'New complaint CMP-1001 was routed to you.'),
(1, 'Dr. Aman Kapoor commented on CMP-1001.'),
(2, 'CMP-1002 was marked Resolved.');

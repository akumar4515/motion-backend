import express from 'express';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';
import puppeteer from 'puppeteer';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Convert logo.jpeg to base64
const logoPath = path.join(__dirname, 'logo.jpeg');
const logoBuffer = fs.readFileSync(logoPath);
const logoBase64 = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;

// Convert signature.png to base64
const signaturePath = path.join(__dirname, 'signature.png');
const signatureBuffer = fs.readFileSync(signaturePath);
const signatureBase64 = `data:image/png;base64,${signatureBuffer.toString('base64')}`;

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ dest: 'uploads/' });

// Debug environment variables
console.log('EMAIL_USER:', process.env.EMAIL_USER);
console.log('EMAIL_PASS:', process.env.EMAIL_PASS);

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('Nodemailer configuration failed:', error);
  } else {
    console.log('Nodemailer is ready to send emails');
  }
});

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: {
    ca: fs.readFileSync('ca.pem'),
  },
};

let pool;

async function initializeDatabase() {
  try {
    console.log('Attempting to connect to MySQL with config:', {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port,
    });
    pool = await mysql.createPool(dbConfig);
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('Successfully connected to MySQL database');
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(403).json({ message: 'No token provided' });

  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
  console.log('Token received:', token); // Debug
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error('JWT Verify Error:', err);
      return res.status(401).json({ message: 'Unauthorized' });
    }
    console.log('Decoded token:', decoded);
    req.userId = decoded.id;
    req.userType = decoded.username ? 'admin' : 'employee';
    next();
  });
};

// Employee login
app.post('/employee/api/login', async (req, res) => {
  const { email, password } = req.body;

  // Check for missing fields
  if (!email && !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }
  if (!password) {
    return res.status(400).json({ message: 'Password is required' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM employees WHERE email = ?', [email]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Incorrect email or password' });
    }
    const employee = rows[0];
    const isValid = await bcrypt.compare(password, employee.password);
    if (!isValid) {
      return res.status(401).json({ message: 'Incorrect email or password' });
    }
    const token = jwt.sign({ id: employee.id, email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    console.error('Employee login error:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Employee creation
app.post('/api/employees', verifyToken, upload.fields([
  { name: 'aadharPhoto', maxCount: 1 },
  { name: 'panPhoto', maxCount: 1 },
]), async (req, res) => {
  const { name, email, phone, address, city, country, state, dob, password, salary_amount } = req.body;
  const aadharPhoto = req.files?.aadharPhoto?.[0];
  const panPhoto = req.files?.panPhoto?.[0];

  // Check for missing required fields
  const missingFields = [];
  if (!name) missingFields.push('name');
  if (!email) missingFields.push('email');
  if (!phone) missingFields.push('phone');
  if (!address) missingFields.push('address');
  if (!city) missingFields.push('city');
  if (!country) missingFields.push('country');
  if (!state) missingFields.push('state');
  if (!dob) missingFields.push('date of birth');
  if (!password) missingFields.push('password');
  if (!aadharPhoto) missingFields.push('Aadhar photo');

  if (missingFields.length > 0) {
    return res.status(400).json({ message: `Missing required fields: ${missingFields.join(', ')}` });
  }

  try {
    // Check if employee already exists by email
    const [existing] = await pool.query('SELECT id FROM employees WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'User already exists with this email' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO employees (name, email, phone, address, city, country, state, dob, aadhar_photo, pan_photo, password, salary_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone, address, city, country, state, dob, aadharPhoto ? aadharPhoto.filename : null, panPhoto ? panPhoto.filename : null, hashedPassword, salary_amount || null]
    );
    res.json({ message: 'Employee added successfully', id: result.insertId, password });
  } catch (error) {
    console.error('Error adding employee:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to add employee' });
  }
});

// Admin login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  // Check for missing fields
  if (!username && !password) {
    return res.status(400).json({ message: 'Username and password are required' });
  }
  if (!username) {
    return res.status(400).json({ message: 'Username is required' });
  }
  if (!password) {
    return res.status(400).json({ message: 'Password is required' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.status(401).json({ message: 'Incorrect username or password' });
    }
    const admin = rows[0];
    const isValidPassword = await bcrypt.compare(password, admin.password);
    if (!isValidPassword) {
      return res.status(401).json({ message: 'Incorrect username or password' });
    }
    const token = jwt.sign({ id: admin.id, username: admin.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
  } catch (error) {
    console.error('Login error:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Salary status
app.get('/api/salary/status/:employeeId', verifyToken, async (req, res) => {
  const { employeeId } = req.params;
  const { month } = req.query;
  if (!month) return res.status(400).json({ message: 'Month is required' });

  try {
    const [rows] = await pool.query('SELECT paid FROM salary WHERE employee_id = ? AND month = ?', [employeeId, month]);
    res.json({ isPaid: rows.length > 0 ? rows[0].paid : false });
  } catch (error) {
    console.error('Error fetching salary status:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch salary status' });
  }
});

// Employee Profile
app.get('/employee/api/profile', verifyToken, async (req, res) => {
  if (req.userType !== 'employee') return res.status(403).json({ message: 'Unauthorized' });
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, address, city, state, country, dob, salary_amount FROM employees WHERE id = ?', [req.userId]);
    if (rows.length === 0) return res.status(404).json({ message: 'Employee not found' });
    res.json({ employee: rows[0] });
  } catch (error) {
    console.error('Profile fetch error:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Employee Attendance History
app.get('/employee/api/attendance/history/:employeeId', verifyToken, async (req, res) => {
  const { employeeId } = req.params;
  if (parseInt(employeeId) !== req.userId && req.userType !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  try {
    const [rows] = await pool.query('SELECT date, present FROM attendance WHERE employee_id = ? ORDER BY date DESC', [employeeId]);
    res.json(rows);
  } catch (error) {
    console.error('Attendance history error:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Employee Salary History
app.get('/employee/api/salary/history/:employeeId', verifyToken, async (req, res) => {
  const { employeeId } = req.params;
  if (parseInt(employeeId) !== req.userId && req.userType !== 'admin') {
    return res.status(403).json({ message: 'Unauthorized' });
  }
  try {
    const [rows] = await pool.query('SELECT month, paid FROM salary WHERE employee_id = ? ORDER BY month DESC', [employeeId]);
    res.json(rows);
  } catch (error) {
    console.error('Salary history error:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Server error' });
  }
});

// Save salary
app.post('/api/salary', verifyToken, async (req, res) => {
  const { employee_id, month, paid } = req.body;
  if (!employee_id || !month || paid === undefined) {
    return res.status(400).json({ message: 'Employee ID, month, and paid status are required' });
  }
  try {
    await pool.query(
      `INSERT INTO salary (employee_id, month, paid)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE paid = ?`,
      [employee_id, month, paid, paid]
    );
    res.json({ message: 'Salary status updated successfully' });
  } catch (error) {
    console.error('Error saving salary:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to save salary' });
  }
});

// Admin Salary History
app.get('/api/salary/history/:employeeId', verifyToken, async (req, res) => {
  const { employeeId } = req.params;
  try {
    const [rows] = await pool.query('SELECT month, paid FROM salary WHERE employee_id = ? ORDER BY month DESC', [employeeId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching salary history:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch salary history' });
  }
});

// Send offer letter
app.post('/api/employees/:id/send-offer-letter', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { doj, salary_amount } = req.body; // Changed SalaryAmnt to salary_amount for consistency

  if (!doj) return res.status(400).json({ message: 'Date of Joining is required' });

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.status(500).json({ message: 'Email configuration is missing' });
  }

  try {
    const [employees] = await pool.query('SELECT * FROM employees WHERE id = ?', [id]);
    if (employees.length === 0) return res.status(404).json({ message: 'Employee not found' });
    const employee = employees[0];
    const salaryDisplay = salary_amount ? `₹${salary_amount}` : (employee.salary_amount ? `₹${employee.salary_amount}` : '₹16,000 (default)');

    const htmlContent = `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; font-size: 12pt; }
            .header { text-align: center; margin-bottom: 20px; }
            .header img { width: 100px; margin-bottom: 10px; }
            .header h1 { font-size: 16pt; margin: 0; color: #333; }
            .header p { margin: 2px 0; font-size: 10pt; color: #555; }
            .content { text-align: justify; margin: 20px 0; }
            .content p { margin: 8px 0; }
            .content h2 { font-size: 14pt; margin-top: 15px; color: #333; page-break-before: avoid; }
            .highlight { font-weight: bold; color: #e74c3c; }
            .footer { margin-top: 20px; font-size: 10pt; color: #777; text-align: center; }
            .signature { page-break-inside: avoid; }
            .signature img { width: 150px; }
            .signature-line { border-top: 1px solid #000; width: 200px; margin: 10px auto; }
          </style>
        </head>
        <body>
          <div class="header">
            <img src="${logoBase64}" alt="Motion View Ventures Logo" />
            <h1>Motion View Ventures Pvt. Ltd.</h1>
            <p>Address: Near Medi Mercy Emergency Hospital, B.H Colony, Vijay Nagar, Kankarbagh, Patna, Bihar - 800026</p>
            <p>Email: contact@motionviewventure.in | Phone No.: +91 7079367125 | Website: motionviewventures.in</p>
          </div>
          <div class="content">
            <p>Date: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')}</p>
            <p>Mr./Ms: ${employee.name}</p>
            <p><strong>SUBJECT: OFFER LETTER FOR THE POST OF FULL STACK DEVELOPER</strong></p>
            <p>Dear ${employee.name.split(' ')[0]},</p>
            <p>This is regarding your application for the above position and the subsequent discussions thereof. We are pleased to inform you that you have been offered the position of <span class="highlight">Full Stack Developer</span> and will be posted to the Patna office. You shall join your duties on ${new Date(doj).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-')}.</p>
            <h2>1. Employment Type:</h2>
            <p>You will be employed on a Full-time basis at Motionview Venture Pvt. Ltd. This is a Fixed-term position, subject to the terms and conditions outlined in this letter.</p>
            <h2>2. Working Hours:</h2>
            <p>Your standard working hours will be from 10:00 AM to 6:00 PM, 6 days a week. You may be required to work additional hours based on business needs. Any Change in the Schedule will be informed you in writing, prior to its effective Date.</p>
            <h2>3. Compensation:</h2>
            <p>You will receive a gross monthly salary of ${salaryDisplay}, payable on a monthly basis.</p>
            <p>The offer letter is valid, subject to the authenticity and correctness of information, preliminary documents (if any) provided by you about your education, experience etc. The Offer (including the appointment) can be withdrawn/terminated at any point in time (without any legal liability on the Company), if the information provided by you is found to be untrue/incorrect.</p>
            <p>By accepting this offer, you agree, acknowledge, and authorize the Company to carry out necessary verifications, background checks on you from (which may be carried out in-house by the HR team or by a third party) your institution, college, previous employer/s, etc. In case of any negative feedback during the verification process, the Company reserves its right to withdraw/terminate this offer (including your appointment) without any legal liability on the Company. In any of the above event(s), you agree to pay back to the Company the amount(s) paid to you, without any objection.</p>
            <h2>4. Leave(s) & Holiday(s)</h2>
            <p>You shall be entitled to leave and holidays as per the HR policy of the Company (in force from time to time), which may be revised, modified or altered by the Management at its sole discretion.</p>
            <p>However S/he shall be entitled to enjoy paid Weekly Offs, National & Festival Holidays, as per the provisions.</p>
            <h2>5. Continuing or Habitual Absence and Unauthorized Leave</h2>
            <p>Absence for a continuing period of 3 (three) days including absence when leave though applied for but not granted, will lead to termination of job without any notice or intimation and without any obligation on the Company, legally and/or otherwise. Further, where leave has been applied for and granted and you have overstayed for a period of two (2) days, will lead to termination of job without any notice or intimation and without any obligation on the Company, legally and/or otherwise. In case you remain absent from duty habitually without prior permission or sanction of leave for a continuous period of two (2) days in a month, then your services shall be liable to termination at the sole discretion of the Management.</p>
            <h2>6. Physical and Mental Fitness</h2>
            <p>Your engagement and continuance in the job is further subject to your remaining physically and mentally fit and the Management shall have a right to get you medically examined at any time from any registered medical practitioner or civil surgeon at its discretion. If you are found medically unfit, your engagement may be terminated at any time by giving you one month's notice or Stipend in lieu thereof.</p>
            <h2>7. Date of Birth</h2>
            <p>Your date of birth as recorded at the time of your engagement with the company shall be considered as the authentic date of birth for all purposes throughout your service with the company and no change shall be permitted under any circumstances.</p>
            <h2>8. Concealment of Material Information</h2>
            <p>If any information/representation made by you in your application for internship and subsequent documents/testimonials submitted is/are found to be untrue or false or if facts come to our notice which have been either concealed or suppressed by you, the Management reserves the right to dispense with your services without giving any notice or compensation in lieu thereof and recover the amount(s)/salary paid to you.</p>
            <h2>9. Correspondence/Communications/Notice and change of address</h2>
            <p>Your address as indicated in your application for internship shall be deemed to be correct for sending you any communication. Every communication addressed to you at the given address shall be deemed to have been duly served upon you.</p>
            <h2>10. Confidentiality Clause:</h2>
            <p>During and after your employment, you must maintain the confidentiality of all proprietary, sensitive, and business-critical information of Motionview Venture Pvt. Ltd. This includes but is not limited to financial data, client information, trade secrets, business strategies, and internal policies. Unauthorized disclosure, duplication, or misuse of such information, either directly or indirectly, will be treated as a serious offense and may result in legal action.</p>
            <h2>11. Non-Compete and Non-Solicitation:</h2>
            <p>For a period, after the termination of your employment, you shall not engage, directly or indirectly, in any business, profession, or activity that competes with the operations of Motionview Venture Pvt. Ltd. Furthermore, you shall not solicit or attempt to solicit any employees, clients, or business partners of Motionview Venture Pvt. Ltd. for personal or professional gain. Any breach of this clause may result in legal action.</p>
            <h2>12. Code of Conduct:</h2>
            <p>As an employee of Motionview Venture Pvt. Ltd., you are expected to adhere to all company policies, procedures, and ethical guidelines. This includes maintaining professionalism, integrity, and accountability in all workplace activities. Any violation of the company's code of conduct, including but not limited to misconduct, harassment, fraud, or negligence, may result in disciplinary action, up to and including termination of employment.</p>
            <h2>13. Dispute Resolution:</h2>
            <p>In the event of any dispute, controversy, or claim arising out of relating to your employment with Motionview Venture Pvt. Ltd., both parties agree to first attempt to resolve the matter amicably through negotiation. If the dispute remains unresolved, it shall be settled through a Court of Law. The decision of the arbitrator/court shall be final and binding on both parties.</p>
            <p>If the above terms and conditions are acceptable to you, please acknowledge by signing below and returning one copy of this letter to us.</p>
            <p>We at Motionview Venture Pvt. Ltd. are excited to have you as part of our team and are confident that it will be a mutually rewarding and fulfilling journey for you. We look forward to a long and a fruitful association with you in the transformational growth journey at Motionview Venture Pvt. Ltd.</p>
            <p>Cordially Yours,<br>For Motion View Ventures Pvt. Ltd.</p>
            <div class="signature">
              <img src="${signatureBase64}" alt="Authorized Signature" />
            </div>
            <p>Agreed and Accepted</p>
            <div class="signature">
              <p>Name: ${employee.name}</p>
              <p>Address: ${employee.address}, ${employee.city}, ${employee.state}, ${employee.country}</p>
            </div>
          </div>
          <div class="footer">
            <p>+91 7079367125 | contact@motionviewventure.in | motionviewventures.in</p>
          </div>
        </body>
      </html>
    `;

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    const pdfPath = path.join(__dirname, 'uploads', `offer_letter_${id}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      margin: { top: '40px', right: '40px', bottom: '40px', left: '40px' },
    });
    await browser.close();

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: employee.email,
      subject: 'Offer Letter from Motion View Ventures Pvt. Ltd.',
      text: `Dear ${employee.name.split(' ')[0]},

I hope you are doing well.

I am pleased to extend a warm welcome to you as the newest member of Motion View Ventures Pvt. Ltd. We are excited to have you join our team and look forward to seeing the great contributions you will make.

Please find attached your offer letter outlining the details of your role, compensation, and other important information. Kindly review the document and confirm your acceptance by replying to this mail or signing and returning a copy.

If you have any questions, feel free to reach out. We are here to support you as you embark on this new journey with us.

Once again, welcome aboard! We look forward to working with you.

Best regards,
Priya Gupta
HR
Motion View Ventures Pvt. Ltd.

Address: Near Medi Mercy Emergency Hospital, B.H Colony, Vijay Nagar, Kankarbagh, Patna, Bihar - 800026
Email: contact@motionviewventures.in
Phone No.: +91 7079367125
Website: motionviewventures.in`,
      attachments: [{ filename: 'offer_letter.pdf', path: pdfPath }],
    };

    await transporter.sendMail(mailOptions);
    await pool.query('UPDATE employees SET doj = ?, salary_amount = ? WHERE id = ?', [doj, salary_amount || employee.salary_amount, id]);
    fs.unlinkSync(pdfPath);

    res.json({ message: 'Offer letter sent successfully' });
  } catch (error) {
    console.error('Error sending offer letter:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to send offer letter', error: error.message });
  }
});

// Fetch all employees (basic info)
app.get('/api/employees', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, salary_amount FROM employees');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching employees:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
});

// Fetch all employees (full info)
app.get('/api/employees/full', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, name, email, phone, address, city, country, state, dob, aadhar_photo, pan_photo, salary_amount FROM employees'
    );
    res.json(rows);
  } catch (error) {
    console.error('Error fetching full employee data:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch employee data' });
  }
});

// Update employee data
app.put('/api/employees/:id', verifyToken, upload.fields([
  { name: 'aadharPhoto', maxCount: 1 },
  { name: 'panPhoto', maxCount: 1 },
]), async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, address, city, country, state, dob, salary_amount } = req.body;
  const aadharPhoto = req.files?.aadharPhoto?.[0];
  const panPhoto = req.files?.panPhoto?.[0];

  if (!name || !email || !phone || !address || !city || !country || !state || !dob) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const [current] = await pool.query('SELECT aadhar_photo, pan_photo FROM employees WHERE id = ?', [id]);
    if (current.length === 0) return res.status(404).json({ message: 'Employee not found' });

    const updateFields = {
      name, email, phone, address, city, country, state, dob,
      salary_amount: salary_amount || null,
      aadhar_photo: aadharPhoto ? aadharPhoto.filename : current[0].aadhar_photo,
      pan_photo: panPhoto ? panPhoto.filename : current[0].pan_photo,
    };

    const [result] = await pool.query(
      `UPDATE employees SET name = ?, email = ?, phone = ?, address = ?, city = ?, country = ?, state = ?, dob = ?, salary_amount = ?, aadhar_photo = ?, pan_photo = ?
       WHERE id = ?`,
      [name, email, phone, address, city, country, state, dob, updateFields.salary_amount, updateFields.aadhar_photo, updateFields.pan_photo, id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Employee not found' });

    if (aadharPhoto && current[0].aadhar_photo) fs.unlinkSync(path.join(__dirname, 'uploads', current[0].aadhar_photo));
    if (panPhoto && current[0].pan_photo) fs.unlinkSync(path.join(__dirname, 'uploads', current[0].pan_photo));

    res.json({ message: 'Employee updated successfully' });
  } catch (error) {
    console.error('Error updating employee:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to update employee' });
  }
});

// Delete employee
app.delete('/api/employees/:id', verifyToken, async (req, res) => {
  const { id } = req.params;

  try {
    const [current] = await pool.query('SELECT aadhar_photo, pan_photo FROM employees WHERE id = ?', [id]);
    if (current.length === 0) return res.status(404).json({ message: 'Employee not found' });

    const [result] = await pool.query('DELETE FROM employees WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Employee not found' });

    if (current[0].aadhar_photo) fs.unlinkSync(path.join(__dirname, 'uploads', current[0].aadhar_photo));
    if (current[0].pan_photo) fs.unlinkSync(path.join(__dirname, 'uploads', current[0].pan_photo));

    res.json({ message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to delete employee' });
  }
});

// Fetch all employees data
app.get('/api/employeesdata', verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email FROM employees');
    res.json(rows);
  } catch (error) {
    console.error('Error fetching employees:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch employees' });
  }
});

// Save attendance
app.post('/api/attendance', verifyToken, async (req, res) => {
  const { employee_id, date, present } = req.body;
  if (!employee_id || !date || present === undefined) {
    return res.status(400).json({ message: 'Employee ID, date, and present status are required' });
  }

  try {
    await pool.query(
      `INSERT INTO attendance (employee_id, date, present)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE present = ?`,
      [employee_id, date, present, present]
    );
    res.json({ message: 'Attendance marked successfully' });
  } catch (error) {
    console.error('Error saving attendance:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    if (error.code === 'ER_NO_SUCH_TABLE') {
      res.status(500).json({ message: 'Attendance table does not exist in the database' });
    } else {
      res.status(500).json({ message: 'Failed to save attendance', error: error.message });
    }
  }
});

// Fetch attendance history
app.get('/api/attendance/history/:employeeId', verifyToken, async (req, res) => {
  const { employeeId } = req.params;
  try {
    const [rows] = await pool.query('SELECT date, present FROM attendance WHERE employee_id = ? ORDER BY date DESC', [employeeId]);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching attendance history:', error);
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ message: 'No internet connection or database unreachable' });
    }
    res.status(500).json({ message: 'Failed to fetch attendance history' });
  }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  if (!pool) return res.status(503).json({ status: 'error', message: 'Database not connected' });

  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ status: 'ok', message: 'Database connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', message: 'Database connection failed' });
  }
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  const dbConnected = await initializeDatabase();
  if (dbConnected) {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } else {
    console.error('Server failed to start due to database connection issues');
    process.exit(1);
  }
  
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Convert logo.jpeg to base64
const logoPath = path.join(__dirname, 'logo.jpeg');
const logoBuffer = fs.readFileSync(logoPath);
const logoBase64 = `data:image/jpeg;base64,${logoBuffer.toString('base64')}`;
console.log(logoBase64)

// Convert signature.png to base64
const signaturePath = path.join(__dirname, 'signature.png');
const signatureBuffer = fs.readFileSync(signaturePath);
const signatureBase64 = `data:image/png;base64,${signatureBuffer.toString('base64')}`;
console.log(signatureBase64)
}

startServer();
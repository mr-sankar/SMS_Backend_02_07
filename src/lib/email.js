import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

export async function sendEmail(to, subject, html) {
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to,
    subject,
    html,
  });
}

export async function sendStaffCredentialsEmail({
  to,
  name,
  staffId,
  username,
  password,
}) {
   const loginUrl =
    process.env.FRONTEND_URL || "https://www.google.com";

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
  </head>
  <body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif;">
    
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:30px 0;">
      <tr>
        <td align="center">

          <table width="650" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr>
              <td style="background:#2563eb;padding:30px;text-align:center;">
                <h1 style="color:#ffffff;margin:0;font-size:28px;">
                  School Management System
                </h1>
              </td>
            </tr>

            <!-- Welcome -->
            <tr>
              <td style="padding:35px;">
                <h2 style="margin-top:0;color:#111827;">
                  Welcome, ${name} 👋
                </h2>

                <p style="font-size:15px;color:#4b5563;line-height:1.7;">
                  Your staff account has been successfully created in the
                  <strong>School Management System</strong>.
                  Please use the credentials below to access your account.
                </p>

                <!-- Credentials Card -->
                <div style="
                  background:#f8fafc;
                  border:1px solid #e5e7eb;
                  border-radius:10px;
                  padding:20px;
                  margin:25px 0;
                ">
                  
                  <h3 style="margin-top:0;color:#1f2937;">
                    Login Information
                  </h3>

                  <p style="margin:10px 0;">
                    <strong>ID:</strong> ${staffId}
                  </p>

                  <p style="margin:10px 0;">
                    <strong>Username:</strong> ${username}
                  </p>

                  <p style="margin:10px 0;">
                    <strong>Password:</strong> ${password}
                  </p>
                </div>

                 <!-- Login Button -->
                <div style="text-align:center;margin:30px 0;">
                  <a
                    href="${loginUrl}"
                    target="_blank"
                    style="
                      background:#2563eb;
                      color:#ffffff;
                      text-decoration:none;
                      padding:14px 28px;
                      border-radius:8px;
                      display:inline-block;
                      font-weight:bold;
                    "
                  >
                    Login to Portal
                  </a>
                </div>

                <!-- Direct Link -->
                <p style="font-size:14px;color:#6b7280;">
                  If the button doesn't work, copy and paste this link into your browser:
                  <br/>
                  <a href="${loginUrl}">${loginUrl}</a>
                </p>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="
                background:#f9fafb;
                text-align:center;
                padding:20px;
                color:#6b7280;
                font-size:12px;
                border-top:1px solid #e5e7eb;
              ">
                © ${new Date().getFullYear()} School Management System.
                All Rights Reserved.
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>

  </body>
  </html>
  `;

  return sendEmail(
    to,
    "Your School Management System Account Credentials",
    html
  );
}
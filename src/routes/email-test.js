import { Router } from "express";
import { sendEmail } from "../lib/email.js";

const router = Router();

router.get("/test-email", async (_req, res) => {
  const to = process.env.TEST_EMAIL;
  if (!to) {
    return res.status(400).json({ success: false, message: "Set TEST_EMAIL in .env to receive the test email." });
  }
  try {
    const data = await sendEmail(
      to,
      "School Management Test",
      `
        <h2>Email Service Working 🚀</h2>
        <p>This email was sent using Gmail API OAuth2.</p>
      `
    );

    res.json({ success: true, message: "Email sent", info: data });
  } catch (error) {
    console.error("Test email error:", error);
    res.status(500).json({ success: false, message: error.message || "Failed to send email", error: String(error) });
  }
});

export default router;

import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;
const from = process.env.RESEND_FROM ?? "auth@example.com";

const resend = apiKey ? new Resend(apiKey) : null;

export async function sendVerificationEmail(to: string, url: string): Promise<void> {
  const subject = "Verify your Qclick account";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #111;">Confirm your email</h2>
      <p style="color: #444; line-height: 1.5;">
        Welcome to Qclick. Click the button below to verify your email address.
        The link is valid for one hour.
      </p>
      <p style="margin: 32px 0;">
        <a href="${url}" style="background: #111; color: #fff; padding: 12px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">
          Verify email
        </a>
      </p>
      <p style="color: #888; font-size: 13px;">
        If the button doesn't work, paste this URL into your browser:<br>
        <a href="${url}">${url}</a>
      </p>
    </div>
  `;

  if (!resend) {
    console.log(`[email] RESEND_API_KEY not set; would have sent to ${to}:\n${url}`);
    return;
  }

  const { error } = await resend.emails.send({ from, to, subject, html });
  if (error) {
    throw new Error(`Resend send failed: ${JSON.stringify(error)}`);
  }
}

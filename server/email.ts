// Pluggable transactional email sender.
// - If RESEND_API_KEY is set, sends via Resend (https://resend.com).
// - Otherwise logs the message server-side so flows still work in dev / before
//   an email provider is connected.

const resendApiKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.EMAIL_FROM || "TapSocials <onboarding@resend.dev>";
const appName = process.env.APP_NAME || "TapSocials";

export function isEmailConfigured(): boolean {
  return Boolean(resendApiKey);
}

export interface SendResult {
  delivered: boolean;
  fallbackLogged: boolean;
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  if (!resendApiKey) {
    console.log(`[email] RESEND_API_KEY not set — not sending. To: ${to} | Subject: ${subject}\n${text}`);
    return { delivered: false, fallbackLogged: true };
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: emailFrom, to, subject, html, text })
    });
    if (!response.ok) {
      const body = await response.text();
      console.error(`[email] Resend send failed: ${response.status} ${body}`);
      return { delivered: false, fallbackLogged: false };
    }
    return { delivered: true, fallbackLogged: false };
  } catch (error) {
    console.error("[email] Resend send threw", error);
    return { delivered: false, fallbackLogged: false };
  }
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<SendResult> {
  const subject = `Reset your ${appName} password`;
  const text = [
    `We received a request to reset your ${appName} password.`,
    "",
    `Reset it here (link expires in 1 hour):`,
    resetUrl,
    "",
    "If you didn't request this, you can safely ignore this email — your password won't change."
  ].join("\n");

  const safeUrl = escapeHtmlAttr(resetUrl);
  const html = `<!doctype html><html><body style="margin:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#f2f2f3;padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#0f0f12;border:1px solid #27272f;border-radius:14px;overflow:hidden">
      <tr><td style="padding:28px 28px 8px">
        <p style="margin:0;font-size:18px;font-weight:700;color:#f2f2f3">${escapeHtmlAttr(appName)}</p>
      </td></tr>
      <tr><td style="padding:8px 28px 0">
        <h1 style="margin:0 0 10px;font-size:20px;color:#f2f2f3">Reset your password</h1>
        <p style="margin:0 0 22px;font-size:14px;line-height:1.55;color:#a1a1aa">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
        <a href="${safeUrl}" style="display:inline-block;background:#22d3ee;color:#071014;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px">Reset password</a>
        <p style="margin:22px 0 0;font-size:12px;line-height:1.5;color:#71717a">If the button doesn't work, paste this link into your browser:<br><a href="${safeUrl}" style="color:#22d3ee;word-break:break-all">${safeUrl}</a></p>
      </td></tr>
      <tr><td style="padding:22px 28px 28px">
        <p style="margin:0;font-size:12px;line-height:1.5;color:#52525b;border-top:1px solid #27272f;padding-top:16px">If you didn't request a password reset, you can safely ignore this email — your password won't change.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;

  return sendEmail(to, subject, html, text);
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&#39;";
  });
}

const DEFAULT_FROM = "TapSocials <noreply@tapsocials.com>";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY is not set; password reset link for ${to}: ${resetUrl}`);
    return;
  }

  const safeUrl = escapeHtml(resetUrl);
  const html = `<!doctype html>
  <html lang="en">
    <body style="margin:0;background:#09090b;color:#f2f2f3;font-family:Inter,ui-sans-serif,system-ui,sans-serif;padding:32px;">
      <div style="max-width:480px;margin:0 auto;background:#0f0f12;border:1px solid #27272f;border-radius:12px;padding:28px;">
        <h1 style="margin:0 0 12px;font-size:20px;">Reset your TapSocials password</h1>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.6;">We received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        <a href="${safeUrl}" style="display:inline-block;background:#22d3ee;color:#071014;font-weight:700;text-decoration:none;padding:12px 18px;border-radius:8px;">Reset password</a>
        <p style="margin:20px 0 0;color:#71717a;font-size:13px;line-height:1.6;word-break:break-all;">Or paste this link into your browser:<br />${safeUrl}</p>
      </div>
    </body>
  </html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || DEFAULT_FROM,
      to,
      subject: "Reset your TapSocials password",
      html,
      text: `Reset your TapSocials password using this link (expires in 1 hour): ${resetUrl}`
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Email provider responded with ${response.status}: ${detail}`);
  }
}

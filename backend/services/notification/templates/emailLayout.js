// Shared HTML email shell.
//
// Email clients are not browsers. The constraints below are not stylistic
// preferences — breaking any of them breaks rendering somewhere:
//   * table layout only (no flex/grid/float; Outlook ignores them)
//   * every style inline (Resend does not inline for you, and Gmail strips
//     <head> styles entirely — the <style> block here must be purely additive)
//   * <=600px, because that's the widest reliable reading-pane width
//   * explicit bgcolor AND inline background-color on each cell, or Gmail's
//     dark-mode inverter turns transparent cells black under white text
//   * mid-tone brand colors survive inversion; pure #000/#fff pairs do not

const BRAND = "#137fec";
const INK = "#0f172a";
const MUTED = "#64748b";
const BORDER = "#e2e8f0";
const SURFACE = "#ffffff";
const CANVAS = "#f1f5f9";

// Every interpolated value must go through this. Vendor names, tenant-authored
// issue titles, and the landlord-edited draft (4000 chars of free text) all
// reach these templates.
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Preheader padding: stops Gmail scraping body copy into the inbox preview.
const PREHEADER_PAD = "&#847;&zwnj;&nbsp;".repeat(60);

function renderPreheader(text) {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${SURFACE};opacity:0;">${escapeHtml(
    text
  )}${PREHEADER_PAD}</div>`;
}

function renderButton({ href, label }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
  <tr>
    <td bgcolor="${BRAND}" style="background-color:${BRAND};border-radius:8px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 30px;font-family:Helvetica,Arial,sans-serif;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(
        label
      )}</a>
    </td>
  </tr>
</table>`;
}

function renderCard(innerHtml) {
  return `<tr>
  <td bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:0 32px;">
    ${innerHtml}
  </td>
</tr>`;
}

function renderLayout({ title, preheader, bodyHtml, footerHtml }) {
  return `<!-- ${escapeHtml(title)} -->
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<style>
  @media (max-width:600px) {
    .stack { display:block !important; width:100% !important; }
    .pad { padding-left:20px !important; padding-right:20px !important; }
  }
</style>
${renderPreheader(preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${CANVAS}" style="background-color:${CANVAS};margin:0;padding:0;width:100%;-webkit-text-size-adjust:100%;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:collapse;">

        <tr>
          <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:28px 32px 4px 32px;border-radius:12px 12px 0 0;font-family:Helvetica,Arial,sans-serif;">
            <span style="font-family:Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${BRAND};letter-spacing:-0.02em;">Artrelo</span>
          </td>
        </tr>

        ${bodyHtml}

        <tr>
          <td class="pad" bgcolor="${SURFACE}" style="background-color:${SURFACE};padding:24px 32px 28px 32px;border-radius:0 0 12px 12px;border-top:1px solid ${BORDER};font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:${MUTED};">
            ${footerHtml}
          </td>
        </tr>

        <tr>
          <td style="padding:16px 8px;font-family:Helvetica,Arial,sans-serif;font-size:11px;line-height:16px;color:${MUTED};text-align:center;">
            Artrelo coordinates maintenance on behalf of property managers.
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>`;
}

module.exports = {
  BRAND,
  INK,
  MUTED,
  BORDER,
  SURFACE,
  CANVAS,
  escapeHtml,
  renderLayout,
  renderCard,
  renderButton,
  renderPreheader,
};

import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** A page of the sign-in, with the headers it must be served with. */
export interface RenderedPage {
    html: string;
    headers: Record<string, string>;
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; background: Canvas; color: CanvasText; }
main { width: 100%; max-width: 420px; text-align: center; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
p { margin: 0 0 20px; line-height: 1.5; }
.muted { opacity: 0.75; font-size: 0.95rem; }
.qr { background: #fff; border-radius: 12px; padding: 12px; display: inline-block; margin: 0 0 20px; }
.qr svg { width: 240px; height: 240px; display: block; }
a.button { display: inline-block; padding: 14px 28px; border-radius: 10px; background: #1a56db; color: #fff; font-weight: 600; text-decoration: none; margin: 0 0 20px; }
`;

function headers(scriptNonce?: string): Record<string, string> {
    const scripts = scriptNonce ? `'nonce-${scriptNonce}'` : "'none'";
    return {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        // The page is never framed, so it cannot be overlaid (clickjacking).
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    };
}

function document(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

/**
 * The sign-in page: a QR code for a wallet on another device, a link for a
 * wallet on this one, and a script that asks the status endpoint whether to
 * continue. Every value is escaped; the script only reads data attributes.
 */
export async function renderSignInPage(input: {
    sameDeviceRequest: string;
    crossDeviceRequest: string;
    statusUrl: string;
    completeUrl: string;
}): Promise<RenderedPage> {
    const qr = await QRCode.toString(input.crossDeviceRequest, {
        type: "svg",
        errorCorrectionLevel: "M",
        margin: 1,
    });
    const nonce = randomBytes(16).toString("base64");
    const body = `<h1>Sign in with your wallet</h1>
<p class="muted">Scan the code with the wallet on your phone, or open the wallet on this device.</p>
<div class="qr" role="img" aria-label="QR code with the presentation request">${qr}</div>
<p><a class="button" href="${escapeHtml(input.sameDeviceRequest)}">Open wallet on this device</a></p>
<p class="muted" id="status" aria-live="polite">Waiting for your wallet…</p>
<div id="sign-in" data-status="${escapeHtml(input.statusUrl)}" data-complete="${escapeHtml(input.completeUrl)}" hidden></div>
<script nonce="${nonce}">
(function () {
  var el = document.getElementById("sign-in");
  var statusUrl = el.getAttribute("data-status");
  var completeUrl = el.getAttribute("data-complete");
  function poll() {
    fetch(statusUrl, { credentials: "same-origin", cache: "no-store" })
      .then(function (response) {
        if (response.ok) return response.json();
        if (response.status >= 400 && response.status < 500) {
          window.location.replace(completeUrl);
          return null;
        }
        throw new Error("status " + response.status);
      })
      .then(function (body) {
        if (body && body.state === "ready") {
          window.location.replace(completeUrl);
        } else if (body) {
          setTimeout(poll, 2000);
        }
      })
      .catch(function () { setTimeout(poll, 4000); });
  }
  setTimeout(poll, 2000);
})();
</script>`;
    return {
        html: document("Sign in with your wallet", body),
        headers: headers(nonce),
    };
}

/** A page with a message only, for a browser that cannot continue. */
export function renderMessagePage(
    title: string,
    message: string,
): RenderedPage {
    const body = `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>`;
    return { html: document(title, body), headers: headers() };
}

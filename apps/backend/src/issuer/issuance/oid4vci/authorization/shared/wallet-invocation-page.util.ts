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

/**
 * Page that hands the browser over to the wallet through a link the user taps.
 *
 * A bare 302 to a custom scheme such as `openid4vp://` is dropped by Android
 * Custom Tabs when no user gesture started the navigation, so the wallet never
 * receives the presentation request. A tap on the link counts as that gesture.
 */
export function renderWalletInvocationPage(walletUrl: string): string {
    const href = escapeHtml(walletUrl);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Continue in your wallet</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box; font-family: system-ui, -apple-system, sans-serif; background: Canvas; color: CanvasText; }
main { max-width: 420px; text-align: center; }
h1 { font-size: 1.4rem; margin: 0 0 12px; }
p { margin: 0 0 24px; line-height: 1.5; opacity: 0.8; }
a { display: inline-block; padding: 14px 28px; border-radius: 10px; background: #1a56db; color: #fff; font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>Share credentials from your wallet</h1>
<p>A presentation is required to continue the issuance.</p>
<a href="${href}">Open wallet</a>
</main>
</body>
</html>
`;
}

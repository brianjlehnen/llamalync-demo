/**
 * Renders the styled login page. Vanta-brand-colored, single password field,
 * logo above the form. Used by the session-auth middleware when an unauth'd
 * HTML client hits any gated route.
 */

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderLoginPage(opts = {}) {
  const error = opts.error;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LlamaLync · Sign in</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <style>
    /* Vanta brand palette */
    :root {
      --bg: #240642;          /* Vanta Dark Purple — login page background */
      --card: #ffffff;
      --text: #240642;
      --muted: #6e5a7c;
      --border: #e7dfdc;
      --border-strong: #c9bdb6;
      --accent: #ac55ff;       /* Vanta Purple */
      --accent-hover: #9a3def;
      --bad: #f45b5b;
      --bad-bg: #fde5e5;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
      /* Subtle radial gradient on the dark purple bg for visual depth */
      background-image: radial-gradient(ellipse at top, #3a1462 0%, #240642 60%);
    }
    .login-card {
      background: var(--card);
      border-radius: 14px;
      padding: 40px 36px 32px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
    }
    .brand-logo {
      display: block;
      width: 72px;
      height: 72px;
      border-radius: 16px;
      margin: 0 auto 18px;
      object-fit: cover;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      font-weight: 600;
      text-align: center;
      letter-spacing: -0.01em;
    }
    .subtitle {
      margin: 0 0 28px;
      font-size: 13px;
      color: var(--muted);
      text-align: center;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    input[type="password"], input[type="text"] {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      background: #fafafb;
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
      margin-bottom: 16px;
    }
    input[type="password"]:focus, input[type="text"]:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--card);
      box-shadow: 0 0 0 3px rgba(172, 85, 255, 0.18);
    }
    input:disabled {
      background: var(--border);
      color: var(--muted);
      cursor: not-allowed;
    }
    .submit {
      width: 100%;
      padding: 11px 16px;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      background: var(--accent);
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      font-family: inherit;
      transition: background 0.15s;
      margin-top: 4px;
    }
    .submit:hover { background: var(--accent-hover); }
    .submit:disabled { background: var(--muted); cursor: wait; }
    .error {
      padding: 10px 12px;
      background: var(--bad-bg);
      color: var(--bad);
      border-left: 3px solid var(--bad);
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .footnote {
      margin-top: 24px;
      font-size: 11px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <form class="login-card" method="POST" action="/login">
    <img src="/assets/logo.png" alt="LlamaLync" class="brand-logo">
    <h1>LlamaLync</h1>
    <p class="subtitle">Vanta middleware demo · sign in to continue</p>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

    <label for="password">Password</label>
    <input type="password" id="password" name="password" autofocus required autocomplete="current-password">

    <button type="submit" class="submit">Sign in</button>

    <div class="footnote">Set <code>LLAMALYNC_PASSWORD</code> in your environment to gate the dashboard. See the README for setup.</div>
  </form>
</body>
</html>`;
}

module.exports = { renderLoginPage };

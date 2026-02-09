# Public Directory

This folder contains static client assets served by Express.

## Files

- `index.html`: login page
- `register.html`: sign-up + email verification request page
- `verified.html`: email verification success page
- `main.html`: authenticated chat UI
- `style.css`: shared styles for all pages

## Templating Notes

`index.html`, `register.html`, `verified.html`, and `main.html` use server-side token replacement:

- `{{APP_NAME}}`
- `{{APP_CHAT_TITLE}}`
- `{{APP_CONSOLE_LABEL}}`

These values are injected in `server.js` using config from `.env`.

## Guidelines

- Keep files static and framework-free (plain HTML/CSS/JS).
- Do not hardcode service-specific brand names if they can be configured via `.env`.
- If you add a new page with tokens, update server-side rendering logic accordingly.

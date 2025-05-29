# Custom vless-ws-tls Proxy on Cloudflare

This project allows you to deploy a high-speed, custom `vless-ws-tls` proxy using Cloudflare Workers and Cloudflare Pages. It features a professional user interface to display proxy configuration and network information.

## Deployment

You can deploy this project on either Cloudflare Workers or Cloudflare Pages.

## Environment Variables

The following environment variables can be configured in your Cloudflare Worker/Pages settings:

*   **`UUID`** (Recommended)
    *   Your unique user ID.
    *   It is highly recommended to set this to your own UUID.
    *   You can generate one from a UUID generator website (e.g., [uuidgenerator.net](https://www.uuidgenerator.net)).
*   **`PROXYIP`** (Optional)
    *   The IP address of the proxy server.
    *   Default: `turk.radicalization.ir`
    *   Alternative: `nima.nacl.ir`
*   **`DNS_RESOLVER`** (Optional)
    *   The DNS resolver address.
    *   Default: `1.1.1.1`
    *   Alternative: `8.8.8.8` (It's generally best to keep the default).

## User Interface (UI)

This project includes a professional UI built with HTML, CSS, and JavaScript, served via GitHub Pages from the `index.html` file in this repository.

**Modifying the UI:**

If you fork this project and want to modify the UI:

1.  **Enable GitHub Pages:**
    *   Go to your forked repository's **Settings**.
    *   Navigate to the **Pages** section under "Code and automation".
    *   In the "Build and deployment" section, under "Source", select **GitHub Actions**. (If you prefer to deploy from a branch, you can select your `main` branch and `/ (root)` folder, then save).
2.  **Update UI Host URL:**
    *   Open the `index.js` file.
    *   On line 22, update the `HTML_URL` constant to your GitHub Pages URL (e.g., `https://your-username.github.io/your-repo-name/`).
3.  **Apply Changes:**
    *   Any changes you commit and push to your `index.html` file (and related CSS/JS) will now be reflected on your live GitHub Pages site.

## API Services

The UI utilizes API services to detect and display your IP address and the proxy server's IP information:

*   **Client IP Information:** Uses a combination of `api.ipify.org` (to get the public IP) and Scamalytics (via a Cloudflare Worker endpoint defined in `index.js`) to display your IP, location, ISP, and a risk score.
*   **Proxy IP Information:** Uses `ip-api.io` to display the proxy server's IP, location, and ISP.

These services are generally sufficient for personal use.

**Important for Public Forks:**

If you intend to make your fork public or anticipate high traffic, it is strongly recommended to:

1.  **Use Your Own Scamalytics API Key:**
    *   Obtain a free or paid API key from [Scamalytics](https://scamalytics.com/).
    *   In your Cloudflare Worker, set the `SCAMALYTICS_USERNAME` and `SCAMALYTICS_API_KEY` environment variables. Alternatively, you can update the default values directly in `index.js` (lines 25 and 26), but environment variables are recommended for security.
2.  The other services (`api.ipify.org`, `ip-api.io`) are public, but be mindful of their rate limits if you expect very high usage.

## Original Project

This project is based on the work of zizifn and has been updated with a new UI and enhanced functionality.

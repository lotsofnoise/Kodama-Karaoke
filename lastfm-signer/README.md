# Last.fm signer (for Kodama Karaoke builds)

Last.fm needs every sign-in and scrobble request to be **signed with the app's shared secret**.
A secret shipped inside an installer can be pulled out of it, so this fork keeps it in a tiny
free **Cloudflare Worker** instead. Kodama asks the Worker to sign each request; users just click
**Connect** in Kodama and sign in with their own Last.fm account.

- The Worker only signs the requests Kodama uses: sign-in, now playing, scrobble, love/unlove.
- It never sees anyone's Last.fm password, and it stores nothing.
- Your API key and secret are kept as **encrypted Cloudflare secrets** — they're not in this
  repository, not in the installer, and not in Kodama's settings.

## One-time setup

You need [Node.js](https://nodejs.org) (already installed if you built Kodama) and a free
[Cloudflare account](https://dash.cloudflare.com/sign-up).

1. **Create a Last.fm API account** at <https://www.last.fm/api/account/create>.
   Tip: do this while logged into a separate Last.fm account made just for the app.
   Keep the page with the **API key** and **Shared secret** open.

2. **Log in to Cloudflare from PowerShell** (opens your browser — click *Allow*):
   ```powershell
   cd lastfm-signer
   npx wrangler login
   ```

3. **Deploy the Worker:**
   ```powershell
   npx wrangler deploy
   ```
   At the end it prints your Worker's address, like
   `https://kodama-karaoke-lastfm.YOUR-NAME.workers.dev`. Copy it.

4. **Store your key and secret in Cloudflare** (each command asks you to paste the value):
   ```powershell
   npx wrangler secret put LASTFM_API_KEY
   npx wrangler secret put LASTFM_API_SECRET
   ```

5. **Check it works:** open `https://kodama-karaoke-lastfm.YOUR-NAME.workers.dev/key` in your
   browser. It should show `{"api_key":"..."}` (the key is public anyway — it appears in the
   Last.fm sign-in link). If it says `signer_not_configured`, redo step 4.

6. **Tell Kodama where the Worker is:** open `python-backend\lastfm_signer.json` in Notepad and
   put your address in, then save:
   ```json
   {
     "url": "https://kodama-karaoke-lastfm.YOUR-NAME.workers.dev"
   }
   ```
   This address isn't secret, so it's fine to commit it to GitHub.

7. **Rebuild Kodama** (README steps 5 and 8: the server, then the installer). Users of that
   installer can now go to **Settings → Last.fm → Connect**.

## Good to know

- Cloudflare's free plan allows 100,000 requests a day — far more than a group of friends uses.
- Don't create `python-backend\lastfm_config.json` when using the Worker; that file would put the
  secret into the installer, which is exactly what this avoids.
- To turn Last.fm off for everyone, delete the Worker in the Cloudflare dashboard. To change the
  secret, reset it on your Last.fm API page and run step 4 again — no rebuild needed.
- Each person's Last.fm sign-in is saved in their own Kodama profile and stays connected until
  they click **Disconnect**.

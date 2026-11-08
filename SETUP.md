# Setup and daily use

Already done for you: Firebase project **choozr-approval** (free Spark plan, Mumbai region) with email/password sign-in, the Firestore database, security rules and index. Also done: this GitHub repo, with automatic builds of the web app and the Android APK.

## 1. Become the admin (once, 1 minute)

1. Open **https://sumontsc51.github.io/choozr-approval/** (or install the Android app).
2. Tap **New here? Create an account**, then enter your name, email and a password.
3. You'll see **Waiting for access**. Tap **Become admin (first setup only)**. This works only once, for the very first person.

## 2. Add the team

1. Each person opens the same link or app and taps **Create account**.
2. You open **⚙ Settings → Team** and tap their role pill to cycle: *approver → coordinator → admin → no access*.
   * **approver**: approves and rejects orders.
   * **coordinator**: exports from Choozr and sees the approved and rejected lists.
   * **admin**: both, plus team management.
3. ✕ removes a person's access.

## 3. Coordinator PCs: Chrome extension

1. Download **ChoozrExporter-extension.zip** from the [latest release](https://github.com/Sumontsc51/choozr-approval/releases/latest) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder.
3. Click the extension icon and sign in with the coordinator's account (the same one as in the app).
4. Optional: add a **Claude API key** in the same settings page for the AI photo review (see the AI section below).

**Daily use:** on an order in dash.choozr.ai, validate the points (green ticks), then click **Export to approver**. Keep the editor visible for about 5 seconds. The panel then shows:

* **AI result:** ✓ / ? / ✗ with reasons. Suspicious measurement cards get an orange outline, so you can fix them and export again before the approver looks.
* **Status:** waiting / APPROVED / REJECTED. A rejected order shows a red banner with the reason. Fix the points and export again, and it returns to the approver as **REWORK**.

## 4. Approvers: phone

* **Android:** download [MeasurementApprover.apk](https://github.com/Sumontsc51/choozr-approval/releases/latest/download/MeasurementApprover.apk) on the phone and open it. Allow "install unknown apps" once.
* **iPhone:** open https://sumontsc51.github.io/choozr-approval/ in Safari, then Share → **Add to Home Screen**.

Gestures:

* Swipe ← for the side photo, → for the front photo.
* Swipe ↑ for the next order, ↓ for the previous one.
* Double-tap to open the AI check and the validated measurements.
* Pinch to zoom.

New exports appear in the list automatically.

## How the AI works

* **Built-in model (free, always on).**
  * A wrong point gives a measurement that is out of proportion with the rest of the body. The model learns normal proportions from every approved order and flags the one measurement that doesn't fit.
  * Approver reject reasons ("waist line too high"), and measurements that changed during rework, make it stricter for those measurements.
  * Until about 15 orders are approved it only catches very obvious errors.
* **Claude review (optional, paid by Anthropic usage, about $0.02–0.03 per export).**
  * Set it up: create a key at <https://console.anthropic.com> and paste it into the extension settings on a coordinator PC. The key stays on that PC.
  * Claude then also looks at the photos and lines. After each *reject → rework → approve*, missed problem, or false alarm, it writes a general rule into a shared **playbook** and follows it in future reviews.
  * Learning jobs run on that PC every 5 minutes while Chrome is open.
* ⚙ **Settings → AI quality check** shows how often the AI agrees with approvers. The AI never approves anything by itself.

## Free-plan limits and housekeeping

* Screenshots are stored inside Firestore, compressed to about 150–400 KB each.
* **Screenshots of approved orders are deleted 7 days after approval.** The order record and measurements stay.
* Deletion runs whenever someone has the app open, or a coordinator has Chrome open with the extension.
* The free Firestore quota is 1 GiB of storage, 50,000 reads, 20,000 writes and 20,000 deletes per day. With 7-day cleanup that covers hundreds of orders a day.
* Push notifications are not included, because the free plan has no server. Lists update live while the app is open.

## Updating

Push changes to `main`. GitHub Actions rebuilds the web app (about 3 minutes) and the Android APK plus the extension zip (about 20 minutes, under Releases → *latest*). If you edit `shared/ai-core.js`, run `npm run sync` first.

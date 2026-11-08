# Choozr Measurement Approval

Coordinators validate measurement points on **dash.choozr.ai** and press **Export to approver**. The front and side photos (with the lines) and the validated measurements go to the approver, who swipes through orders on a phone and taps **Approve** or **Reject**. Rejected orders show a red banner on the Choozr page. After rework and a new export, they go back to the approver. An AI checks every export and learns from the approvers' decisions.

| | Link |
|---|---|
| **iPhone / any browser** | https://sumontsc51.github.io/choozr-approval/ (Safari → Share → *Add to Home Screen*) |
| **Android app** | [MeasurementApprover.apk](https://github.com/Sumontsc51/choozr-approval/releases/latest/download/MeasurementApprover.apk) |
| **Chrome extension (coordinators)** | [ChoozrExporter-extension.zip](https://github.com/Sumontsc51/choozr-approval/releases/latest/download/ChoozrExporter-extension.zip) |

Everything runs on free tiers: Firebase **Spark** plan (Auth + Firestore), GitHub Pages and GitHub Actions. Setup and daily use are in **[SETUP.md](SETUP.md)**.

## Layout

```
extension/      Chrome extension: capture, export, AI check, status banner, background worker
mobile-app/     Expo / React Native app → Android APK + web app (same code)
shared/         ai-core.js — built-in learning model (copied into extension + app: `npm run sync`)
firebase/       Firestore security rules + index (already deployed to project choozr-approval)
.github/        Actions: web → Pages, Android APK + extension zip → Release "latest"
```

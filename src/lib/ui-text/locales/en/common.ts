// BL-152: words used across the whole interface. English is the source; every key has a translation in each locale.
export const common = {
  "app.description": "Manage your YouTube channels: content, translations, analytics and research",
  "signIn.google": "Sign in with Google",

  "common.loading": "Loading…",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.saving": "Saving…",
  "common.saved": "Saved.",
  "common.retry": "Retry",
  "common.tryAgain": "Try again",
  "common.later": "Later",
  "common.never": "never",
  "common.stopping": "Stopping…",
  "common.success": "Success",
  "common.syncNow": "Sync now",
  "common.syncing": "Syncing…",
  "common.moreInfo": "More info",
  "common.errorStatus": "Error {status}",
  "common.errorDetail": "{text} Details: {detail}",

  "value.notSet": "not set",
  "value.on": "On",
  "value.off": "Off",
  "value.none": "none",

  "unit.usd": "${value}",
  "unit.usdPerHour": "${value}/h",
  "unit.minutes": "{value} min",
  "unit.seconds": "{value} s",
  "unit.gb": "{value} GB",

  "duration.seconds": "{s}s",
  "duration.minutesSeconds": "{m} min {s}s",
  "duration.hoursMinutes": "{h} h {m} min",

  "format.timePlaceholder": "HH:MM",

  "errorBoundary.title": "Something went wrong in {label}.",
  "errorBoundary.body": "The rest of the app is unaffected. You can try again, or switch to another tab.",
} as const;

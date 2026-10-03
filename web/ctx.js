// The shared context. app.js fills it once its own functions exist; feature modules read it at call
// time (never at import time), so modules and app.js can use each other without import cycles.
export const ctx = {}

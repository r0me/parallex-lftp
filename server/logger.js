'use strict';

// Any lftp output can contain user:pass@host URLs (pwd is a known
// offender before a cd runs). Everything logged or returned to the client
// goes through redact() first.
function redact(text) {
  if (text == null) return text;
  return String(text)
    // scheme://user:pass@host -> scheme://user:*****@host
    .replace(/([a-z+]+:\/\/[^\s:/@]+):([^\s@/]+)@/gi, '$1:*****@')
    // open -u user,pass -> open -u user,*****
    .replace(/(-u\s+"?[^\s",]+"?\s*,\s*"?)[^\s"]+("?)/gi, '$1*****$2');
}

function log(scope, msg) {
  const ts = new Date().toISOString();
  console.log(`${ts} [${scope}] ${redact(msg)}`);
}

module.exports = { log, redact };

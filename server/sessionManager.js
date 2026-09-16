'use strict';

const { LftpSession } = require('./lftpSession');
const { log } = require('./logger');

// Tracks active LftpSession instances by session id. One persistent lftp
// process per connected site keeps browsing interactive; transfers run in
// their own short-lived processes (see transferManager).
class SessionManager {
  constructor() {
    this.sessions = new Map();
  }

  async connect(site, settings) {
    const session = new LftpSession(site, settings);
    session.on('exit', () => {
      if (this.sessions.get(session.id) === session) {
        this.sessions.delete(session.id);
        log('sessions', `session ${session.id} removed (process exit)`);
      }
    });
    try {
      const info = await session.connect();
      this.sessions.set(session.id, session);
      return { session, info };
    } catch (err) {
      session.close();
      throw err;
    }
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  disconnect(id) {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    session.close();
    return true;
  }

  closeAll() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

module.exports = { SessionManager };

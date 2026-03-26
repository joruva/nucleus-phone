// In-memory conference state — ephemeral, only matters while calls are live.
// If Render restarts mid-call, this is lost. Acceptable at current volume.
const activeConferences = new Map();

function createConference(conferenceName, data) {
  activeConferences.set(conferenceName, {
    conferenceSid: null,
    startedAt: new Date(),
    startedBy: data.callerIdentity,
    leadPhone: data.to,
    leadName: data.contactName,
    leadCompany: data.companyName,
    contactId: data.contactId,
    dbRowId: data.dbRowId,
    participants: [],
  });
}

function getConference(conferenceName) {
  return activeConferences.get(conferenceName);
}

function updateConference(conferenceName, updates) {
  const conf = activeConferences.get(conferenceName);
  if (conf) {
    Object.assign(conf, updates);
  }
}

function removeConference(conferenceName) {
  activeConferences.delete(conferenceName);
}

function listActiveConferences() {
  const result = [];
  for (const [name, conf] of activeConferences) {
    result.push({ conferenceName: name, ...conf });
  }
  return result;
}

module.exports = {
  createConference,
  getConference,
  updateConference,
  removeConference,
  listActiveConferences,
};

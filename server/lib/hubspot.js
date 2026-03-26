const HUBSPOT_BASE = 'https://api.hubapi.com';

function headers() {
  return {
    'Authorization': `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

const CONTACT_PROPERTIES = [
  'firstname', 'lastname', 'company', 'phone', 'mobilephone',
  'email', 'jobtitle', 'city', 'state', 'hs_lead_status',
  'notes_last_updated',
].join(',');

async function searchContacts(query, limit = 50, after) {
  const body = {
    filterGroups: [],
    properties: CONTACT_PROPERTIES.split(','),
    limit,
    ...(after && { after }),
  };

  if (query) {
    body.query = query;
  }

  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot search failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function getContact(contactId) {
  const res = await fetch(
    `${HUBSPOT_BASE}/crm/v3/objects/contacts/${contactId}?properties=${CONTACT_PROPERTIES}`,
    { headers: headers() }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot get contact failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function addNoteToContact(contactId, noteBody) {
  // Create a note engagement
  const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/notes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      properties: {
        hs_timestamp: new Date().toISOString(),
        hs_note_body: noteBody,
      },
      associations: [
        {
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HubSpot add note failed: ${res.status} ${text}`);
  }

  return res.json();
}

module.exports = { searchContacts, getContact, addNoteToContact };

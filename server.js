import express from 'express';
import crypto from 'crypto';
import { Pool } from 'pg';
import multer from 'multer';
import * as XLSX from 'xlsx';

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 15 * 1024 * 1024
  }
});
const port = Number(process.env.PORT || 10000);

const adminPassword =
  process.env.ADMIN_PASSWORD || 'demo-admin';

const vendorPassword =
  process.env.VENDOR_PASSWORD || 'demo-vendor';

const powerAutomateUrl =
  String(process.env.POWER_AUTOMATE_URL || '').trim();

const baseUrl =
  String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

const testMode =
  String(process.env.TEST_MODE || 'true').toLowerCase() !== 'false';

const testEmail =
  process.env.TEST_EMAIL || 'aciraky@fecrent.com';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not configured');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

/*
  Initial TEST data.

  PostgreSQL becomes the permanent source of truth after the first startup.
  Redeploying the Render web service will NOT reset submitted look-aheads.
*/
const seed = {
  cycles: [
    {
      id: '2026-10-1',
      name: 'October 7th, 2026 Look-Ahead',
      sentDate: '2026-10-07',
      active: true
    }
  ],

  partners: [
    {
      id: 'northstar',
      company: 'Northstar Plumbing',
      contact: 'Demo Trade Partner',
      email: testEmail,
      token: 'demo-northstar-2026-10-1',
      cycleId: '2026-10-1',
      status: 'outstanding',
      reminders: 0,
      lastReminder: null,
      submittedAt: null,
      submission: null
    },

    {
      id: 'apex',
      company: 'Apex Electrical',
      contact: 'Demo Contact',
      email: 'apex@example.com',
      token: 'demo-apex-2026-10-1',
      cycleId: '2026-10-1',
      status: 'complete',
      reminders: 0,
      lastReminder: null,
      submittedAt: '2026-10-07T08:42:00-04:00',
      submission: {
        submittedBy: 'Demo Contact',
        email: 'apex@example.com',
        noEquipment: false,
        items: [
          {
            type: "19' Scissor Lift",
            quantity: 8,
            dateNeeded: '2026-10-19',
            duration: '4 weeks',
            location: 'Area C / L2',
            notes: 'Rough-in'
          }
        ]
      }
    },

    {
      id: 'summit',
      company: 'Summit Mechanical',
      contact: 'Demo Contact',
      email: 'summit@example.com',
      token: 'demo-summit-2026-10-1',
      cycleId: '2026-10-1',
      status: 'complete',
      reminders: 1,
      lastReminder: null,
      submittedAt: '2026-10-07T14:16:00-04:00',
      submission: {
        submittedBy: 'Demo Contact',
        email: 'summit@example.com',
        noEquipment: false,
        items: [
          {
            type: 'Telehandler',
            quantity: 2,
            dateNeeded: '2026-10-26',
            duration: '3 weeks',
            location: 'North laydown',
            notes: ''
          }
        ]
      }
    },

    {
      id: 'keystone',
      company: 'Keystone Drywall',
      contact: 'Demo Contact',
      email: 'keystone@example.com',
      token: 'demo-keystone-2026-10-1',
      cycleId: '2026-10-1',
      status: 'outstanding',
      reminders: 2,
      lastReminder: '2026-10-03T08:00:00-04:00',
      submittedAt: null,
      submission: null
    }
  ]
};

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const existing = await pool.query(
    'SELECT id FROM app_state WHERE id = 1'
  );

  if (existing.rowCount === 0) {
    await pool.query(
      `
        INSERT INTO app_state (id, data)
        VALUES (1, $1::jsonb)
      `,
      [JSON.stringify(seed)]
    );

    console.log('PostgreSQL initialized with test data');
  } else {
    console.log('Existing PostgreSQL data found');
  
    await pool.query(`
    CREATE TABLE IF NOT EXISTS onrent_imports (
      id BIGSERIAL PRIMARY KEY,
      vendor TEXT NOT NULL,
      source_file TEXT,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      record_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'complete'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS onrent_equipment (
      id BIGSERIAL PRIMARY KEY,
      trade_partner TEXT,
      purchase_order TEXT,
      site_contact TEXT,
      equipment_number TEXT,
      equipment_description TEXT,
      serial_number TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      gps TEXT,
      contract_number TEXT,
      start_date DATE,
      return_date DATE,
      vendor TEXT NOT NULL,
      vendor_record_id TEXT,
      source_file TEXT,
      import_id BIGINT REFERENCES onrent_imports(id),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (vendor, vendor_record_id)
    )
  `);
  }
}

async function load() {
  const result = await pool.query(
    'SELECT data FROM app_state WHERE id = 1'
  );

  if (!result.rows.length) {
    throw new Error('Application state not found');
  }

  return result.rows[0].data;
}

async function save(data) {
  await pool.query(
    `
      UPDATE app_state
      SET data = $1::jsonb,
          updated_at = NOW()
      WHERE id = 1
    `,
    [JSON.stringify(data)]
  );
}

function clean(value, max = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function auth(req, role) {
  const header = String(req.headers.authorization || '');

  const password =
    header.startsWith('Bearer ')
      ? header.slice(7)
      : '';

  const expected =
    role === 'admin'
      ? adminPassword
      : vendorPassword;

  const left = Buffer.from(
    password.padEnd(64).slice(0, 64)
  );

  const right = Buffer.from(
    expected.padEnd(64).slice(0, 64)
  );

  return crypto.timingSafeEqual(left, right);
}

app.disable('x-powered-by');

app.use(
  express.json({
    limit: '300kb'
  })
);

/*
  Your GitHub files currently live in the repository root,
  so serve static files directly from the current directory.
*/
app.use(express.static(process.cwd()));

/* Health check */
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      database: 'postgres',
      testMode,
      powerAutomateConfigured: Boolean(powerAutomateUrl)
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      database: 'error'
    });
  }
});

/* Trade-partner request */
app.get('/api/request/:token', async (req, res) => {
  try {
    const data = await load();

    const partner = data.partners.find(
      p => p.token === req.params.token
    );

    if (!partner) {
      return res.status(404).json({
        error: 'Request link not found.'
      });
    }

    const cycle = data.cycles.find(
      c => c.id === partner.cycleId
    );

    return res.json({
      ...partner,
      cycle
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to load request.'
    });
  }
});

/* Trade-partner submission */
app.post('/api/request/:token', async (req, res) => {
  try {
    const data = await load();

    const partner = data.partners.find(
      p => p.token === req.params.token
    );

    if (!partner) {
      return res.status(404).json({
        error: 'Request link not found.'
      });
    }

    if (partner.status === 'complete') {
      return res.status(409).json({
        error: 'This look-ahead has already been submitted.'
      });
    }

    const submittedBy =
      clean(req.body.submittedBy, 120);

    const email =
      clean(req.body.email, 200);

    const noEquipment =
      Boolean(req.body.noEquipment);

    if (!submittedBy || !email) {
      return res.status(400).json({
        error: 'Submitted by and email are required.'
      });
    }

    let items = [];

    if (!noEquipment) {
      if (!Array.isArray(req.body.items) ||
          req.body.items.length === 0) {
        return res.status(400).json({
          error: 'Please add at least one equipment request.'
        });
      }

      items = req.body.items
        .slice(0, 100)
        .map(item => ({
          type: clean(item.type, 200),
          quantity: Math.max(
            1,
            Math.min(
              9999,
              Number.parseInt(item.quantity, 10) || 1
            )
          ),
          dateNeeded: clean(item.dateNeeded, 20),
          duration: clean(item.duration, 100),
          location: clean(
            item.location || item.area,
            300
          ),
          notes: clean(item.notes, 1000)
        }));

      const invalid = items.some(item =>
        !item.type ||
        !item.dateNeeded ||
        !item.duration ||
        !item.location
      );

      if (invalid) {
        return res.status(400).json({
          error:
            'Equipment type, quantity, date needed, duration and location are required.'
        });
      }
    }

    partner.status = 'complete';
    partner.submittedAt = new Date().toISOString();

    partner.submission = {
      submittedBy,
      email,
      noEquipment,
      items
    };

    await save(data);

    /*
      Later, Power Automate can be notified here.
      For now, database storage is the source of truth.
    */
    if (powerAutomateUrl) {
      try {
        await fetch(powerAutomateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            event: 'lookahead-submitted',
            testMode,
            company: partner.company,
            partnerId: partner.id,
            submittedAt: partner.submittedAt,
            submission: partner.submission
          })
        });
      } catch (automationError) {
        console.error(
          'Power Automate notification failed:',
          automationError
        );
      }
    }

    return res.json({
      ok: true,
      company: partner.company,
      submittedAt: partner.submittedAt
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to save look-ahead.'
    });
  }
});

/* Authentication */
function requireAuth(req, res, role) {
  if (!auth(req, role)) {
    res.status(401).json({
      error: 'Unauthorized'
    });

    return false;
  }

  return true;
}


/* Trade Partner Management */

function makePartnerId(company) {
  const base = String(company || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return base || 'trade-partner';
}

function makeRequestToken() {
  return crypto.randomBytes(24).toString('hex');
}

/* Add a trade partner */
app.post('/api/admin/partners', async (req, res) => {
  if (!requireAuth(req, res, 'admin')) {
    return;
  }

  try {
    const company = clean(req.body.company, 150);
    const contact = clean(req.body.contact, 150);
    const email = clean(req.body.email, 200);

    if (!company || !email) {
      return res.status(400).json({
        error: 'Company name and email are required.'
      });
    }

    const data = await load();

    const duplicate = data.partners.some(
      partner =>
        String(partner.company).toLowerCase() ===
        company.toLowerCase()
    );

    if (duplicate) {
      return res.status(409).json({
        error: 'That trade partner already exists.'
      });
    }

    const activeCycle =
      data.cycles.find(cycle => cycle.active) ||
      data.cycles[0];

    let id = makePartnerId(company);
    let counter = 2;

    while (data.partners.some(partner => partner.id === id)) {
      id = `${makePartnerId(company)}-${counter++}`;
    }

    const partner = {
      id,
      company,
      contact,
      email,
      active: true,
      token: makeRequestToken(),
      cycleId: activeCycle?.id || null,
      status: 'outstanding',
      reminders: 0,
      lastReminder: null,
      submittedAt: null,
      submission: null
    };

    data.partners.push(partner);
    await save(data);

    return res.status(201).json({
      ok: true,
      partner
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to add trade partner.'
    });
  }
});

/* Edit a trade partner */
app.put('/api/admin/partners/:id', async (req, res) => {
  if (!requireAuth(req, res, 'admin')) {
    return;
  }

  try {
    const data = await load();

    const partner = data.partners.find(
      item => item.id === req.params.id
    );

    if (!partner) {
      return res.status(404).json({
        error: 'Trade partner not found.'
      });
    }

    const company = clean(req.body.company, 150);
    const contact = clean(req.body.contact, 150);
    const email = clean(req.body.email, 200);

    if (!company || !email) {
      return res.status(400).json({
        error: 'Company name and email are required.'
      });
    }

    const duplicate = data.partners.some(
      item =>
        item.id !== partner.id &&
        String(item.company).toLowerCase() ===
          company.toLowerCase()
    );

    if (duplicate) {
      return res.status(409).json({
        error: 'Another trade partner already uses that company name.'
      });
    }

    partner.company = company;
    partner.contact = contact;
    partner.email = email;

    if (typeof req.body.active === 'boolean') {
      partner.active = req.body.active;
    }

    await save(data);

    return res.json({
      ok: true,
      partner
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to update trade partner.'
    });
  }
});

/* Generate a new unique request link */
app.post('/api/admin/partners/:id/new-token', async (req, res) => {
   (!requireAuth(req, res, 'admin')) {
    return;
  }

  try {
    const data = await load();

    const partner = data.partners.find(
      item => item.id === req.params.id
    );

     (!partner) {
      return res.status(404).json({
        error: 'Trade partner not found.'
      });
    }

    partner.token = makeRequestToken();

    await save(data);

    return res.json({
      ok: true,
      token: partner.token
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to generate a new request link.'
    });
  }
});
/* Management dashboard */
app.get('/api/dashboard', async (req, res) => {
   (!requireAuth(req, res, 'admin')) {
    return;
  }

  try {
    const data = await load();
    return res.json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to load dashboard.'
    });
  }
});



/* FEC vendor report detector - preview only */
app.post(
  '/api/onrent/detect',
  upload.single('report'),
  async (req, res) => {
    try {
       (!req.file) {
        return res.status(400).json({
          ok: false,
          error: 'No vendor report was uploaded.'
        });
      }

      const workbook = XLSX.read(req.file.buffer, {
        type: 'buffer',
        cellDates: true
      });

      const sheetName = workbook.SheetNames[0];

      if (!sheetName) {
        return res.status(400).json({
          ok: false,
          error: 'The uploaded report does not contain a worksheet.'
        });
      }

      const worksheet = workbook.Sheets[sheetName];

      const rows = XLSX.utils.sheet_to_json(worksheet, {
        defval: '',
        raw: false
      });

      const headers = rows.length
        ? Object.keys(rows[0]).map(value =>
            String(value).trim()
          )
        : [];

      const normalizedHeaders = headers.map(value =>
        value.toLowerCase()
      );

      let vendor = 'Unknown';

      const hasEquipmentShareFields =
        normalizedHeaders.includes('product') &&
        (
          normalizedHeaders.includes('rental id') ||
          normalizedHeaders.includes('sub-renter company')
        );

      const hasUnitedFields =
        normalizedHeaders.some(header =>
          header.includes('cat class')
        ) &&
        normalizedHeaders.some(header =>
          header.includes('contract')
        );

      if (hasEquipmentShareFields) {
        vendor = 'EquipmentShare';
      } else if (hasUnitedFields) {
        vendor = 'United Rentals';
      }
      let normalizedRows = [];

      if (vendor === 'EquipmentShare') {
        normalizedRows = rows.map((row, index) => {
          const tradePartner =
            String(row['Sub-Renter Company'] || row['Job'] || '').trim();

          const purchaseOrder =
            String(row['Sub-renter PO'] || row['PO#'] || '').trim();

          const siteContact =
            String(
              row['Sub-renter requester'] ||
              row['Ordered by'] ||
              ''
            ).trim();

          const orderedBy =
            String(row['Ordered by'] || '').trim();

          const product =
            String(row['Product'] || '').trim();

          const equipmentClass =
            String(row['Class'] || '').trim();

          const make =
            String(row['Make'] || '').trim();

          const model =
            String(row['Model'] || '').trim();

          const equipmentDescription = [
            product,
            make,
            model
          ]
            .filter(Boolean)
            .join(' - ');

          return {
            sourceRow: index + 2,

            tradePartner,
            purchaseOrder,
            orderedBy,
            siteContact,

            equipmentDescription,
            catClass: equipmentClass,

            quantity:
              Number.parseInt(row['Qty'], 10) || 1,

            equipmentNumber:
              String(row['Devices'] || '').trim(),

            serialNumber: '',

            contractNumber:
              String(row['Rental ID'] || '').trim(),

            startDate:
              String(row['start date'] || '').trim(),

            returnDate:
              String(row['end date'] || '').trim(),

            locationName:
              String(row['Location Name'] || '').trim(),

            locationAddress:
              String(row['Location Address'] || '').trim(),

            status:
              String(row['Status'] || '').trim(),

            sourceVendor: 'EquipmentShare'
          };
        });
      }
            return res.json({
        ok: true,
        vendor,
        fileName: req.file.originalname,
        sheetName,
        rowCount: rows.length,
        headers,
        normalizedCount: normalizedRows.length,
        preview: normalizedRows.slice(0, 5)
      });

    } catch (error) {
      console.error(error);

      return res.status(400).json({
        ok: false,
        error: 'Unable to read this vendor report.'
      });
    }
  }
);
app.get('/api/onrent', async (req, res) => {
  try {
    const equipmentResult = await pool.query(`
      SELECT
        id,
        trade_partner,
        purchase_order,
        site_contact,
        equipment_number,
        equipment_description,
        serial_number,
        quantity,
        gps,
        contract_number,
        start_date,
        return_date,
        last_seen_at
      FROM onrent_equipment
      WHERE active = TRUE
      ORDER BY
        trade_partner NULLS LAST,
        equipment_description NULLS LAST,
        equipment_number NULLS LAST
    `);

    const importResult = await pool.query(`
      SELECT imported_at
      FROM onrent_imports
      WHERE status = 'complete'
      ORDER BY imported_at DESC
      LIMIT 1
    `);

    const equipment = equipmentResult.rows;

    const equipmentQty = equipment.reduce(
      (total, item) => total + (Number(item.quantity) || 0),
      0
    );

    const tradePartners = new Set(
      equipment
        .map(item => item.trade_partner)
        .filter(Boolean)
    ).size;

    const equipmentGroups = new Set(
      equipment
        .map(item => item.equipment_description)
        .filter(Boolean)
    ).size;

    return res.json({
      ok: true,
      stats: {
        equipmentQty,
        tradePartners,
        equipmentGroups,
        lastUpdated:
          importResult.rows[0]?.imported_at || null
      },
      equipment
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: 'Unable to load on-rent equipment.'
    });
  }
});
/* United Rentals read-only planning view */
app.get('/api/vendor', async (req, res) => {
  if (!requireAuth(req, res, 'vendor')) {
    return;
  }

  try {
    const data = await load();
    const rows = [];

    data.partners
      .filter(
        partner =>
          partner.status === 'complete' &&
          partner.submission
      )
      .forEach(partner => {
        const items =
          partner.submission.items || [];

        items.forEach(item => {
          rows.push({
            company: partner.company,
            type: item.type || '',
            quantity: Number(item.quantity) || 0,
            dateNeeded: item.dateNeeded || '',
            duration: item.duration || '',
            location:
              item.location ||
              item.area ||
              '',
            notes: item.notes || ''
          });
        });
      });

    rows.sort((a, b) =>
      String(a.dateNeeded).localeCompare(
        String(b.dateNeeded)
      )
    );

    return res.json(rows);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to load vendor data.'
    });
  }
});

/* Test-email payload preview / future Power Automate trigger */
app.post('/api/admin/test-email', async (req, res) => {
  if (!requireAuth(req, res, 'admin')) {
    return;
  }

  try {
    const data = await load();

const requestedPartnerId = clean(req.body?.partnerId, 100);

const partner = requestedPartnerId
  ? data.partners.find(
      p => p.id === requestedPartnerId
    )
  : data.partners.find(
      p => p.id === 'northstar'
    );

    if (!partner) {
      return res.status(404).json({
error: 'Trade partner not found.'
      });
    }

    const origin =
      baseUrl ||
      `${req.protocol}://${req.get('host')}`;

    const requestUrl =
      `${origin}/request.html?token=` +
      encodeURIComponent(partner.token);

   const htmlBody = `
<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:650px;">

  <h2 style="margin:0 0 8px 0;">
    4-Week Equipment Look-Ahead
  </h2>

  <p>
    <strong>Trade Partner:</strong> ${partner.company}
  </p>

  <p>
    Your company's upcoming equipment look-ahead is ready for completion.
  </p>

  <p>
    Please identify all rental equipment your team anticipates needing during the upcoming 4-week period.
  </p>

  <p>
    <strong>
      A response is required even if you do not anticipate needing additional equipment.
    </strong>
  </p>

  <p style="margin:28px 0;">
    <a
      href="${requestUrl}"
      style="background:#1478e8;color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:6px;font-weight:bold;display:inline-block;"
    >
      COMPLETE EQUIPMENT LOOK-AHEAD
    </a>
  </p>

  <p>
    Please complete the look-ahead as soon as possible. Automated reminders will continue until your company's submission has been received.
  </p>

  <p>
    Providing accurate advance notice helps the project team and United Rentals plan equipment availability and reduce last-minute requests.
  </p>

  <p>
    Thank you,<br>
    <strong>Project Equipment Team</strong>
  </p>

</div>
`;

const payload = {
  event: 'lookahead-test-email',
  testMode: true,
  to: testEmail,
  subject: 'Action Required - 4-Week Equipment Look-Ahead',
  htmlBody
};

    if (!powerAutomateUrl) {
      return res.json({
        ok: true,
        sent: false,
        reason:
          'POWER_AUTOMATE_URL is not configured.',
        preview: payload
      });
    }

    const response = await fetch(
      powerAutomateUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    return res.json({
      ok: response.ok,
      sent: response.ok,
      status: response.status,
      preview: payload
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: 'Unable to prepare test email.'
    });
  }
});

/*
  Initialize PostgreSQL BEFORE accepting traffic.
*/
try {
  await initializeDatabase();

  app.listen(port, () => {
    console.log(
      `FEC Equipment Look-Ahead listening on ${port}`
    );
    console.log(
      'Persistent storage: PostgreSQL'
    );
  });

} catch (error) {
  console.error(
    'Unable to initialize PostgreSQL:',
    error
  );

  process.exit(1);
}

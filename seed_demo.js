/**
 * Seed script — creates the HR Assistant demo agent with 2 skills, 2 tools,
 * global RAG docs, and skill-specific RAG docs.
 *
 * Usage:
 *   node seed_demo.js
 *
 * Requires DATABASE_URL in environment (or .env.local via dotenv).
 */
import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

// Load .env.local if present
try {
  const env = readFileSync('.env.local', 'utf-8');
  for (const line of env.split('\n')) {
    const [k, ...v] = line.split('=');
    if (k && !process.env[k]) process.env[k] = v.join('=').trim();
  }
} catch {}

const sql = neon(process.env.DATABASE_URL);

function uid() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const agentId = uid();
const onboardingSkillId = uid();
const leaveSkillId = uid();

const agent = {
  id: agentId,
  name: 'HR Assistant',
  avatar: '👩‍💼',
  openingMessage: "Hello! I'm your HR assistant for Acme Corp. I can help with onboarding, leave requests, company policies, and benefits. How can I assist you today?",
  basePrompt: `You are a professional HR assistant for Acme Corp.
You have access to company knowledge and can help employees with HR-related questions.

Always be professional, empathetic, and accurate.
If you're unsure about a policy detail, check the relevant context documents first.
When handling leave requests, always verify the employee's remaining balance using the calculate_days_off tool before submitting.`,
  skills: [
    {
      id: onboardingSkillId,
      name: 'Onboarding',
      description: 'Helps new employees with the onboarding process, first-day tasks, IT setup, and getting settled in',
      prompt: `## Onboarding Specialist Mode

You are now in onboarding mode. Focus on:
- First-day checklist and orientation
- IT setup and system access
- Team introductions and company culture
- Required documents and forms to complete

Always check the relevant knowledge documents before answering to ensure accuracy.
Be warm, welcoming, and patient — new employees may feel overwhelmed.`,
    },
    {
      id: leaveSkillId,
      name: 'LeaveManager',
      description: 'Handles vacation requests, sick days, and leave policy questions',
      prompt: `## Leave Management Mode

You are now in leave management mode. You can:
- Explain leave types (vacation, sick, parental, personal)
- Check available days using the calculate_days_off tool
- Submit leave requests using the submit_leave_request tool

Always verify the employee's remaining balance before submitting a request.
Ask for employee ID if not provided. Leave types: vacation, sick, personal, parental.`,
    },
  ],
  tools: [
    {
      id: uid(),
      name: 'calculate_days_off',
      description: 'Calculates remaining vacation and leave days for an employee',
      parameters: [
        { name: 'employee_id', type: 'string', description: 'Employee ID number (e.g. E001)' },
        { name: 'year', type: 'integer', description: 'Year to check (e.g. 2025)' },
      ],
      code: `def run(**kwargs):
    employee_id = kwargs.get("employee_id", "")
    year = kwargs.get("year", 2025)

    # Mock HR system data
    mock_data = {
        "E001": {"name": "Alice Cohen", "total": 20, "used": 7, "pending": 2},
        "E002": {"name": "Bob Levi", "total": 20, "used": 15, "pending": 0},
        "E003": {"name": "Carol Green", "total": 20, "used": 3, "pending": 5},
    }

    data = mock_data.get(employee_id)
    if not data:
        return f"Employee {employee_id} not found. Available IDs: E001, E002, E003"

    remaining = data["total"] - data["used"] - data["pending"]
    return (
        f"Employee: {data['name']} ({employee_id}) | Year: {year}\\n"
        f"Total vacation days: {data['total']}\\n"
        f"Used: {data['used']} | Pending approval: {data['pending']} | Remaining: {remaining}"
    )
`,
    },
    {
      id: uid(),
      name: 'submit_leave_request',
      description: 'Submits a leave request to the HR system and returns a confirmation reference',
      parameters: [
        { name: 'employee_id', type: 'string', description: 'Employee ID (e.g. E001)' },
        { name: 'start_date', type: 'string', description: 'Start date in YYYY-MM-DD format' },
        { name: 'end_date', type: 'string', description: 'End date in YYYY-MM-DD format' },
        { name: 'leave_type', type: 'string', description: 'Type of leave: vacation, sick, personal, or parental' },
      ],
      code: `import datetime

def run(**kwargs):
    emp = kwargs.get("employee_id", "")
    start = kwargs.get("start_date", "")
    end = kwargs.get("end_date", "")
    leave_type = kwargs.get("leave_type", "vacation")

    # Calculate business days
    try:
        s = datetime.date.fromisoformat(start)
        e = datetime.date.fromisoformat(end)
        if e < s:
            return "Error: end_date must be after start_date"
        days = sum(1 for i in range((e - s).days + 1)
                   if (s + datetime.timedelta(i)).weekday() < 5)
    except ValueError:
        return "Error: invalid date format. Use YYYY-MM-DD"

    ref = f"LR-{emp}-{start.replace('-', '')}"
    return (
        f"Leave request submitted successfully!\\n"
        f"Reference: {ref}\\n"
        f"Type: {leave_type.capitalize()} leave\\n"
        f"Period: {start} to {end} ({days} business days)\\n"
        f"Status: Pending manager approval\\n"
        f"You will receive an email confirmation within 24 hours."
    )
`,
    },
  ],
  apiConfig: { provider: 'claude', apiKey: '', model: 'claude-sonnet-4-5' },
  createdAt: new Date().toISOString(),
};

// Documents
const globalDocs = [
  {
    id: uid(),
    title: 'Acme Corp — Company Overview',
    content: `Acme Corp was founded in 2010 and is headquartered in Tel Aviv, Israel.
We have 500+ employees across 3 offices (Tel Aviv, New York, London).
Our core values are Innovation, Integrity, and Impact.
HR department contact: hr@acme.com | Phone: +972-3-555-0100
HR office hours: Sunday–Thursday, 09:00–17:00 (Israel time).
All HR forms are available on the internal portal at portal.acme.com/hr.`,
  },
  {
    id: uid(),
    title: 'Employee Benefits Package',
    content: `Health Insurance: 100% covered for the employee, 50% for spouse/partner, 30% for children.
Dental: Covered up to 2,000 NIS/year.
Vision: Covered up to 800 NIS/year.
Gym & Wellness: 200 NIS/month subsidy — submit receipts via portal.acme.com/benefits.
Meal vouchers: 40 NIS/day on working days.
Phone stipend: 150 NIS/month for personal phone used for work.
Pension: Company contributes 6.5% of gross salary.
Education budget: 3,000 NIS/year for courses and conferences.`,
  },
];

const onboardingDocs = [
  {
    id: uid(),
    title: 'New Employee Onboarding Checklist',
    content: `Day 1:
- Sign NDA and employment contract with HR
- Collect laptop from IT (Floor 2, Room 204)
- Set up email (firstname.lastname@acme.com)
- Install VPN: Cisco AnyConnect — download from portal.acme.com/it
- Set up 2-factor authentication (Microsoft Authenticator)
- Meet your team lead for introductions

Week 1:
- Complete mandatory Compliance & Security training (portal.acme.com/training)
- Complete GDPR awareness training
- Join company all-hands (every Monday 10:00)
- Set up Slack, Jira, and Confluence access

Week 2–4:
- Shadow 3 colleagues from different teams
- Complete first 1-on-1 with manager
- Submit your personal goals for the quarter`,
  },
  {
    id: uid(),
    title: 'IT Setup Guide',
    content: `Laptop: MacBook Pro 14" (M3) or Windows ThinkPad X1 — request via IT ticket.
VPN: Download Cisco AnyConnect from portal.acme.com/it. Server: vpn.acme.com.
Email & Calendar: Microsoft 365 — auto-provisioned on Day 1.
Slack workspace: acme-corp.slack.com — invite sent to personal email.
2FA: Required for all systems. Use Microsoft Authenticator app.
Password manager: 1Password — licenses issued by IT. Request via Slack #it-support.
Monitors & peripherals: Request via portal.acme.com/it within first week.
IT support: Slack #it-support | Email it@acme.com | Hours: 08:00–18:00 Sun–Thu.`,
  },
];

const leaveDocs = [
  {
    id: uid(),
    title: 'Leave Policy 2025',
    content: `VACATION LEAVE:
- 20 days/year, accrued monthly (1.67 days/month)
- Requires manager approval at least 2 weeks in advance for 3+ consecutive days
- Maximum 5 unused days can roll over to next year
- Payout on termination: unused days paid at daily rate

SICK LEAVE:
- 10 days/year, no carryover
- Doctor's note required for 3+ consecutive sick days
- Submit same day via portal.acme.com/leave

PARENTAL LEAVE:
- Primary caregiver: 16 weeks fully paid
- Secondary caregiver: 4 weeks fully paid
- Additional 8 weeks unpaid available upon request
- Notify HR at least 8 weeks before expected leave start

PERSONAL LEAVE:
- 3 days/year for personal emergencies
- Requires manager notification (not pre-approval)
- Cannot be carried over

HOW TO SUBMIT:
All leave requests: portal.acme.com/leave or ask HR Assistant to submit for you.
Approval flow: Employee → Manager → HR confirmation within 2 business days.`,
  },
];

async function seed() {
  console.log('Seeding HR Assistant demo agent…');

  // Insert agent
  await sql`
    insert into agents (id, data)
    values (${agentId}, ${JSON.stringify(agent)}::jsonb)
    on conflict (id) do update set data = excluded.data, updated_at = now()
  `;
  console.log(`✓ Agent inserted: ${agentId}`);

  // Insert global docs
  for (const doc of globalDocs) {
    await sql`
      insert into documents (id, agent_id, skill_id, title, content)
      values (${doc.id}, ${agentId}, null, ${doc.title}, ${doc.content})
      on conflict (id) do nothing
    `;
    console.log(`  ✓ Global doc: ${doc.title}`);
  }

  // Insert onboarding skill docs
  for (const doc of onboardingDocs) {
    await sql`
      insert into documents (id, agent_id, skill_id, title, content)
      values (${doc.id}, ${agentId}, ${onboardingSkillId}, ${doc.title}, ${doc.content})
      on conflict (id) do nothing
    `;
    console.log(`  ✓ Onboarding doc: ${doc.title}`);
  }

  // Insert leave skill docs
  for (const doc of leaveDocs) {
    await sql`
      insert into documents (id, agent_id, skill_id, title, content)
      values (${doc.id}, ${agentId}, ${leaveSkillId}, ${doc.title}, ${doc.content})
      on conflict (id) do nothing
    `;
    console.log(`  ✓ Leave doc: ${doc.title}`);
  }

  console.log('\n✅ Demo agent seeded successfully!');
  console.log('→ Open the app → enter your password → "HR Assistant" will appear in the list.');
  console.log('→ Add your API key in Configuration → test in the Chat drawer.');
  console.log('\nDemo flow to test RAG:');
  console.log('  1. Ask "What are the health insurance benefits?" → global RAG kicks in');
  console.log('  2. Type #Onboarding → ask "What do I need on day 1?" → skill RAG kicks in');
  console.log('  3. Type #LeaveManager → ask "How many days off does E001 have?" → tool call');
}

seed().catch(err => { console.error(err); process.exit(1); });

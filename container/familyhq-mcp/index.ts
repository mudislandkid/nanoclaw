/**
 * Family HQ MCP Server
 * Runs inside the agent container and provides family data tools via the Family HQ REST API.
 * Env vars: FAMILY_HQ_API_URL, FAMILY_HQ_API_SECRET
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.FAMILY_HQ_API_URL || '';
const API_SECRET = process.env.FAMILY_HQ_API_SECRET || '';

if (!API_URL) {
  console.error('FAMILY_HQ_API_URL not set');
  process.exit(1);
}

async function apiGet(path: string): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    headers: {
      'X-Service-Auth': API_SECRET,
      'Content-Type': 'application/json',
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'X-Service-Auth': API_SECRET,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return { success: true };
  return resp.json();
}

async function apiPatch(path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${API_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'X-Service-Auth': API_SECRET,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'familyhq',
  version: '1.0.0',
});

// --- Family Members ---

server.tool(
  'family_members',
  'List all family members with their names, roles, and IDs',
  {},
  async () => {
    const data = await apiGet('/family/members');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Calendar ---

server.tool(
  'calendar_events',
  'List calendar events in a date range. Returns event title, dates, times, location, and assigned members.',
  {
    start_date: z.string().describe('Start date in YYYY-MM-DD format'),
    end_date: z.string().describe('End date in YYYY-MM-DD format'),
  },
  async ({ start_date, end_date }) => {
    const data = await apiGet(`/calendar/events?start_date=${start_date}&end_date=${end_date}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'create_calendar_event',
  'Create a new calendar event. Requires title, start_date, end_date, and at least one member_id.',
  {
    title: z.string().describe('Event title'),
    start_date: z.string().describe('Start date YYYY-MM-DD'),
    end_date: z.string().describe('End date YYYY-MM-DD'),
    start_time: z.string().optional().describe('Start time HH:MM:SS (omit for all-day)'),
    end_time: z.string().optional().describe('End time HH:MM:SS (omit for all-day)'),
    all_day: z.boolean().optional().describe('Whether this is an all-day event'),
    location: z.string().optional().describe('Event location'),
    description: z.string().optional().describe('Event description'),
    category: z.string().optional().describe('Category: general, appointment, school, social, recurring, reminder, holiday'),
    member_ids: z.array(z.string()).describe('Array of family member IDs to assign'),
  },
  async (params) => {
    const data = await apiPost('/calendar/events', params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Tasks ---

server.tool(
  'task_lists',
  'List all task lists',
  {},
  async () => {
    const data = await apiGet('/tasks/lists');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'tasks_in_list',
  'Get all tasks in a specific task list',
  {
    list_id: z.string().describe('Task list ID'),
  },
  async ({ list_id }) => {
    const data = await apiGet(`/tasks/lists/${list_id}/tasks`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'create_task',
  'Create a new task',
  {
    title: z.string().describe('Task title'),
    list_id: z.string().describe('Task list ID to add the task to'),
    description: z.string().optional().describe('Task description'),
    due_date: z.string().optional().describe('Due date YYYY-MM-DD'),
    priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
    assigned_to: z.string().optional().describe('Member ID to assign the task to'),
  },
  async (params) => {
    const data = await apiPost('/tasks/tasks', params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'update_task',
  'Update an existing task (mark complete, change priority, reassign, etc.)',
  {
    task_id: z.string().describe('Task ID'),
    status: z.string().optional().describe('Status: todo, in_progress, done'),
    title: z.string().optional().describe('New title'),
    priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
    assigned_to: z.string().optional().describe('Member ID to reassign to'),
    due_date: z.string().optional().describe('New due date YYYY-MM-DD'),
  },
  async ({ task_id, ...updates }) => {
    const data = await apiPatch(`/tasks/tasks/${task_id}`, updates);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Shopping List ---

server.tool(
  'shopping_list',
  'Get the current shopping list',
  {},
  async () => {
    const data = await apiGet('/tasks/shopping');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'add_shopping_item',
  'Add an item to the shopping list',
  {
    title: z.string().describe('Item name'),
  },
  async ({ title }) => {
    const data = await apiPost('/tasks/shopping/items', { title });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Medications ---

server.tool(
  'medications',
  'List all medications with their status (ok, reorder_soon, overdue, unknown), days remaining, and supply info',
  {},
  async () => {
    const data = await apiGet('/health/medications');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'medication_reminders',
  'Get medications that need reordering soon or are overdue',
  {
    days_ahead: z.number().optional().describe('How many days ahead to check (default 7)'),
  },
  async ({ days_ahead }) => {
    const da = days_ahead ?? 7;
    const data = await apiGet(`/health/medications/reminders?days_ahead=${da}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'collect_medication',
  'Log that a medication prescription has been collected/picked up. Resets the supply countdown.',
  {
    medication_id: z.string().describe('Medication ID'),
    date: z.string().optional().describe('Collection date YYYY-MM-DD (defaults to today)'),
  },
  async ({ medication_id, date }) => {
    const data = await apiPost(`/health/medications/${medication_id}/collect`, { date: date ?? null });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Pets ---

server.tool(
  'pets',
  'List all pets with their details',
  {},
  async () => {
    const data = await apiGet('/pets');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'pet_reminders',
  'Get upcoming pet care reminders (vaccinations, flea treatments, vet visits, etc.)',
  {
    days_ahead: z.number().optional().describe('How many days ahead to check (default 30)'),
  },
  async ({ days_ahead }) => {
    const da = days_ahead ?? 30;
    const data = await apiGet(`/pets/reminders?days_ahead=${da}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Vehicles ---

server.tool(
  'vehicles',
  'List all vehicles with MOT, tax, and insurance dates',
  {},
  async () => {
    const data = await apiGet('/vehicles');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'vehicle_reminders',
  'Get upcoming vehicle reminders (MOT, tax, insurance, service due)',
  {
    days_ahead: z.number().optional().describe('How many days ahead to check (default 30)'),
  },
  async ({ days_ahead }) => {
    const da = days_ahead ?? 30;
    const data = await apiGet(`/vehicles/reminders?days_ahead=${da}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Kids Chores ---

server.tool(
  'list_chores',
  'List all chores configured for the kids',
  {},
  async () => {
    const data = await apiGet('/kids/chores');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'create_chore',
  'Create a new chore for one or more children. Frequency can be one_off, daily, specific_days, or weekly.',
  {
    title: z.string().describe('Chore title, e.g. "Make bed"'),
    description: z.string().optional().describe('Description of what the chore involves'),
    frequency: z.string().describe('one_off, daily, specific_days, or weekly'),
    specific_days: z.array(z.number()).optional().describe('Days of week (0=Mon..6=Sun) — required if frequency is specific_days'),
    reward_value: z.number().optional().describe('Pocket money reward in pounds (e.g. 0.50)'),
    requires_approval: z.boolean().optional().describe('Whether a parent must approve completion (default true)'),
    child_ids: z.array(z.string()).describe('Array of child member IDs to assign the chore to'),
    icon: z.string().optional().describe('Icon name (default "star")'),
  },
  async (params) => {
    const data = await apiPost('/kids/chores', params);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'update_chore',
  'Update an existing chore (change title, reward, frequency, etc.)',
  {
    chore_id: z.string().describe('Chore ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    frequency: z.string().optional().describe('one_off, daily, specific_days, or weekly'),
    reward_value: z.number().optional().describe('New reward value in pounds'),
    is_active: z.boolean().optional().describe('Activate or deactivate the chore'),
  },
  async ({ chore_id, ...updates }) => {
    const data = await apiPatch(`/kids/chores/${chore_id}`, updates);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Kids Wallet ---

server.tool(
  'kid_wallet',
  'Get a child\'s wallet balance and earned/pending amounts',
  {
    child_id: z.string().describe('Child member ID'),
  },
  async ({ child_id }) => {
    const data = await apiGet(`/kids/wallet/${child_id}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'kid_transactions',
  'Get a child\'s transaction history (earnings, payments, adjustments)',
  {
    child_id: z.string().describe('Child member ID'),
  },
  async ({ child_id }) => {
    const data = await apiGet(`/kids/wallet/${child_id}/transactions`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'pending_approvals',
  'Get chore completions waiting for parent approval',
  {},
  async () => {
    const data = await apiGet('/kids/approvals/pending');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'approve_chore',
  'Approve or reject a completed chore',
  {
    completion_id: z.string().describe('Chore completion ID'),
    approved: z.boolean().describe('true to approve, false to reject'),
    feedback: z.string().optional().describe('Optional feedback message'),
  },
  async ({ completion_id, ...body }) => {
    const data = await apiPost(`/kids/approvals/${completion_id}`, body);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- School Day ---

server.tool(
  'school_day_today',
  'Get today\'s school day pack status — what activities and items are needed',
  {},
  async () => {
    const data = await apiGet('/school-day/today');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'school_day_week',
  'Get a child\'s school day schedule for the week',
  {
    child_id: z.string().describe('Child member ID'),
  },
  async ({ child_id }) => {
    const data = await apiGet(`/school-day/children/${child_id}/week`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Documents ---

server.tool(
  'list_documents',
  'List uploaded family documents (school letters, bills, records, etc.)',
  {},
  async () => {
    const data = await apiGet('/documents');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'search_documents',
  'Search documents by keyword',
  {
    query: z.string().describe('Search query'),
  },
  async ({ query }) => {
    const data = await apiGet(`/documents/search?q=${encodeURIComponent(query)}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Notifications ---

server.tool(
  'notifications',
  'Get recent notifications for the family',
  {},
  async () => {
    const data = await apiGet('/notifications?limit=20');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// --- Dashboard ---

server.tool(
  'dashboard',
  'Get the family dashboard summary (events today, tasks due, notifications, etc.)',
  {},
  async () => {
    const data = await apiGet('/dashboard');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

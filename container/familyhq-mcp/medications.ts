import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiHelpers } from './index.js';

export function registerMedicationTools(server: McpServer, api: ApiHelpers): void {
  server.tool(
    'medications',
    'List all medications with their status (ok, reorder_soon, overdue, unknown), days remaining, and supply info',
    {},
    async () => {
      const data = await api.apiGet('/health/medications');
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
      const data = await api.apiGet(`/health/medications/reminders?days_ahead=${da}`);
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
      const data = await api.apiPost(`/health/medications/${medication_id}/collect`, { date: date ?? null });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'create_medication',
    'Create a new medication record. `name`, `member_id`, and `supply_days` are required.',
    {
      name: z.string().describe('Medication name'),
      member_id: z.string().describe('Family member ID this medication belongs to'),
      supply_days: z.number().int().describe('How many days of supply each prescription provides'),
      reorder_lead_days: z.number().int().optional().describe('Days before running out to start reordering (default 7 server-side)'),
      notes: z.string().optional(),
    },
    async (params) => {
      const data = await api.apiPost('/health/medications', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'update_medication',
    'Update an existing medication record. Only the fields you pass are changed.',
    {
      medication_id: z.string().describe('Medication ID'),
      name: z.string().optional(),
      member_id: z.string().optional().describe('Family member ID'),
      supply_days: z.number().int().min(1).optional(),
      reorder_lead_days: z.number().int().min(0).optional(),
      notes: z.string().optional(),
    },
    async ({ medication_id, ...updates }) => {
      const data = await api.apiPatch(`/health/medications/${medication_id}`, updates);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'delete_medication',
    'PERMANENTLY delete a medication record. Confirm with the user before calling.',
    {
      medication_id: z.string().describe('Medication ID'),
    },
    async ({ medication_id }) => {
      const data = await api.apiDelete(`/health/medications/${medication_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}

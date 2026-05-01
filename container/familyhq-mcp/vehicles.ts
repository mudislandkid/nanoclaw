import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiHelpers } from './index.js';

export function registerVehicleTools(server: McpServer, api: ApiHelpers): void {
  server.tool(
    'vehicles',
    'List all vehicles with MOT, tax, and insurance dates',
    {},
    async () => {
      const data = await api.apiGet('/vehicles');
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
      const data = await api.apiGet(`/vehicles/reminders?days_ahead=${da}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'create_vehicle',
    'Create a new vehicle record. `make` and `model` are required.',
    {
      make: z.string().describe('e.g. Tesla, Ford'),
      model: z.string().describe('e.g. Model 3, Focus'),
      year: z.number().int().optional(),
      colour: z.string().optional(),
      registration: z.string().optional().describe('License plate'),
      mot_expiry: z.string().optional().describe('YYYY-MM-DD'),
      tax_expiry: z.string().optional().describe('YYYY-MM-DD'),
      insurance_provider: z.string().optional(),
      insurance_policy_number: z.string().optional(),
      insurance_renewal_date: z.string().optional().describe('YYYY-MM-DD'),
    },
    async (params) => {
      const data = await api.apiPost('/vehicles', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'update_vehicle',
    'Update an existing vehicle record. Only the fields you pass are changed.',
    {
      vehicle_id: z.string().describe('Vehicle ID'),
      make: z.string().optional(),
      model: z.string().optional(),
      year: z.number().int().optional(),
      colour: z.string().optional(),
      registration: z.string().optional(),
      mot_expiry: z.string().optional().describe('YYYY-MM-DD'),
      tax_expiry: z.string().optional().describe('YYYY-MM-DD'),
      insurance_provider: z.string().optional(),
      insurance_policy_number: z.string().optional(),
      insurance_renewal_date: z.string().optional().describe('YYYY-MM-DD'),
    },
    async ({ vehicle_id, ...updates }) => {
      const data = await api.apiPatch(`/vehicles/${vehicle_id}`, updates);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'delete_vehicle',
    'PERMANENTLY delete a vehicle record. Confirm with the user before calling.',
    {
      vehicle_id: z.string().describe('Vehicle ID'),
    },
    async ({ vehicle_id }) => {
      const data = await api.apiDelete(`/vehicles/${vehicle_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'add_vehicle_service',
    'Log a vehicle service event (MOT, service, repair, etc.). Optionally schedule the next due date.',
    {
      vehicle_id: z.string().describe('Vehicle ID'),
      event_type: z.string().describe('mot, service, repair, tyres, oil_change, other'),
      title: z.string().describe('Short description'),
      date: z.string().describe('Event date YYYY-MM-DD'),
      next_due: z.string().optional().describe('Next due date YYYY-MM-DD'),
      cost: z.number().optional().describe('Cost in pounds'),
      mileage: z.number().int().optional().describe('Vehicle mileage at the time'),
      provider: z.string().optional().describe('Garage / service provider'),
      notes: z.string().optional(),
    },
    async ({ vehicle_id, ...body }) => {
      const data = await api.apiPost(`/vehicles/${vehicle_id}/services`, { vehicle_id, ...body });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}

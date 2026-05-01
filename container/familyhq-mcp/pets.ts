import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiHelpers } from './index.js';

export function registerPetTools(server: McpServer, api: ApiHelpers): void {
  server.tool(
    'pets',
    'List all pets with their details',
    {},
    async () => {
      const data = await api.apiGet('/pets');
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
      const data = await api.apiGet(`/pets/reminders?days_ahead=${da}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'create_pet',
    'Create a new pet record. Only `name` is required; species and breed should be filled in when known.',
    {
      name: z.string().describe('Pet name'),
      species: z.string().optional().describe('e.g. dog, cat, rabbit'),
      breed: z.string().optional(),
      date_of_birth: z.string().optional().describe('YYYY-MM-DD'),
      photo_url: z.string().optional(),
      owner_id: z.string().optional().describe('Family member ID who owns the pet'),
      vet_practice_name: z.string().optional(),
      vet_phone: z.string().optional(),
      vet_address: z.string().optional(),
      insurance_provider: z.string().optional(),
      insurance_policy_number: z.string().optional(),
      insurance_renewal_date: z.string().optional().describe('YYYY-MM-DD'),
      microchip_number: z.string().optional(),
      medical_notes: z.string().optional(),
    },
    async (params) => {
      const data = await api.apiPost('/pets', params);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'update_pet',
    'Update an existing pet record. Only the fields you pass are changed.',
    {
      pet_id: z.string().describe('Pet ID'),
      name: z.string().optional(),
      species: z.string().optional(),
      breed: z.string().optional(),
      date_of_birth: z.string().optional().describe('YYYY-MM-DD'),
      photo_url: z.string().optional(),
      owner_id: z.string().optional().describe('Family member ID'),
      vet_practice_name: z.string().optional(),
      vet_phone: z.string().optional(),
      vet_address: z.string().optional(),
      insurance_provider: z.string().optional(),
      insurance_policy_number: z.string().optional(),
      insurance_renewal_date: z.string().optional().describe('YYYY-MM-DD'),
      microchip_number: z.string().optional(),
      medical_notes: z.string().optional(),
    },
    async ({ pet_id, ...updates }) => {
      const data = await api.apiPatch(`/pets/${pet_id}`, updates);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'delete_pet',
    'PERMANENTLY delete a pet record. Confirm with the user before calling.',
    {
      pet_id: z.string().describe('Pet ID'),
    },
    async ({ pet_id }) => {
      const data = await api.apiDelete(`/pets/${pet_id}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );

  server.tool(
    'add_pet_care_event',
    'Log a pet care event (vaccination, flea treatment, vet visit, etc.). Optionally schedule the next due date.',
    {
      pet_id: z.string().describe('Pet ID'),
      event_type: z.string().describe('vaccination, flea_treatment, worming, vet_visit, grooming, other'),
      title: z.string().describe('Short description, e.g. "Annual booster"'),
      date: z.string().describe('Event date YYYY-MM-DD'),
      next_due: z.string().optional().describe('Next due date YYYY-MM-DD'),
      cost: z.number().optional().describe('Cost in pounds'),
      notes: z.string().optional(),
      provider: z.string().optional().describe('Vet practice or provider name'),
    },
    async ({ pet_id, ...body }) => {
      const data = await api.apiPost(`/pets/${pet_id}/care`, { pet_id, ...body });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}

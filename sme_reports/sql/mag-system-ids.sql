-- Every mag-processed system: the fleet_summary universe and the filter
-- for users' magnet scopes.
SELECT id FROM public.systems WHERE process_mag = true ORDER BY id

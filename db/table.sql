CREATE  TYPE report_threshold_data_type_enum as enum ('int', 'char', 'bool');

CREATE TABLE alert.reports (
	id SERIAL,
	author  TEXT,
	alert_models TEXT[],
	operator text,   -- less_than, greater_than
	threshold text, -- NUMERIC VALUE TO DO WORK ON. Could be NULL IF NO CONDITION WANTED
	threshold_data_type report_threshold_data_type_enum,
	cc_list TEXT[],
	email_schedule JSONB,
	PRIMARY KEY (id, author)
);
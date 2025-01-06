-- Migration number: 0001 	 2025-01-07T21:23:09.435Z

-- This table exists to enforce the daily rate limit
create table emails
(
	id  integer PRIMARY key autoincrement,
	from_address   text,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

create table memories
(
	id  integer PRIMARY key autoincrement,
	email          text not null,
	request        text,
	content        text,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

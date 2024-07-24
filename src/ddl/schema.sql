----------------------------------------------------------------
-- holds the schema number
--
--
create table if not exists schema (
  id        integer primary key not null check (id = 1),
  version   integer not null
);
insert or ignore into schema values(1, 1);

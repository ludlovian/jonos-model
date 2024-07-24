----------------------------------------------------------------
-- System status table

create table if not exists systemStatus (
  id        integer primary key not null check (id = 1),
  started   float,
  version   text,
  listeners integer
);

insert or ignore into systemStatus (id) values (1);


----------------------------------------------------------------



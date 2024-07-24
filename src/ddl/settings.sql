----------------------------------------------------------------
--
-- settings table, with a single row

create table if not exists settings (
  id                integer primary key not null check (id = 1),
  cifsPrefix        text not null,
  libraryRoot       text not null
);

insert or ignore into settings
  values (
    1,
    'x-file-cifs://pi2.local/data/',
    'library/files'
  );

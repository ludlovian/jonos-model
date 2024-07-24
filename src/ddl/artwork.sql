----------------------------------------------------------------
-- artwork
--

create table if not exists artwork (
  id            integer primary key,
  file          text,
  hash          text,
  image         blob,
  unique (file)
);



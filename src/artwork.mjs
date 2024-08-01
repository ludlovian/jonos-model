export default `
----------------------------------------------------------------
--
-- The artwork sub-database
--

create table if not exists artwork (
  id            integer primary key,
  file          text,
  hash          text,
  image         blob,
  unique (file)
);


----------------------------------------------------------------

-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`

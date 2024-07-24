----------------------------------------------------------------
-- radio stations

create table if not exists radio (
  id            integer primary key,
  title         text,
  nowPlaying    text,
  foreign key (id) references media (id)
);

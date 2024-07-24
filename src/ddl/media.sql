----------------------------------------------------------------
--
-- media items that can be played
--
--  - a library track
--  - a radio stream
--  - an http web stream
--  - the TV input
--  - following another player
--  - a spotify queue
--  - a spotify item
--
-- Each is given an unique id
--

create table if not exists media (
  id            integer primary key,
  type          integer not null,
  sonosUrl      text not null,
  artwork       integer,
  played        real,
  unique (sonosUrl),
  foreign key (artwork) references artwork (id)
);


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

----------------------------------------------------------------
--
drop view if exists mediaEx;
create view if not exists mediaEx as
  select  a.id,
          b.name as type,
          a.sonosUrl,
          datetime(played, 'localtime') as played
    from  media a
    join  mediaType b on b.id = a.type;

----------------------------------------------------------------

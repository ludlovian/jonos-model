export default `----------------------------------------------------------------
-- holds the schema number
--
--
create table if not exists schema (
  id        integer primary key not null check (id = 1),
  version   integer not null
);
insert or ignore into schema values(1, 1);
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


----------------------------------------------------------------
create table if not exists mediaType (
  id            integer primary key,
  name          text,
  prefix        text,
  artwork       integer,      -- default art for the type
  unique (name),
  unique (prefix),
  foreign key (artwork) references artwork (id)
);

insert or ignore into mediaType(id, name, prefix)
  values  (1, 'queue',  'x-rincon-queue:'),
          (2, 'follow', 'x-rincon:'),
          (3, 'radio',  'x-rincon-mp3radio:'),
          (4, 'tv',     'x-sonos-htastream:'),
          (5, 'track',  'x-file-cifs:'),
          (6, 'web',    'https:'),
          (7, 'sonos',  'x-rincon'),
          (9, 'other',  '');

----------------------------------------------------------------
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
-- radio stations

create table if not exists radio (
  id            integer primary key,
  title         text,
  nowPlaying    text,
  foreign key (id) references media (id)
);

----------------------------------------------------------------
--
-- The FTS search tables

create virtual table if not exists searchAlbum
  using fts5(id, text);

----------------------------------------------------------------
--
-- Rebuild sproc
--

create view if not exists rebuildSearch (unused) as select 0  where 0;

create trigger if not exists rebuildSearch_sproc instead of insert on rebuildSearch
begin

  delete from searchAlbum;
  insert into searchAlbum (id, text)
    select
      id,
      concat_ws(' ',
        title,
        artist,
        genre
      )
    from  album;

end;

----------------------------------------------------------------
-- tracks

create table if not exists track (
  id            integer primary key,
  album         integer,
  seq           integer,
  file          text,       -- file within path
  title         text,
  artist        text,       -- JSON array of artist names
  unique (album, seq),
  foreign key (id) references media (id),
  foreign key (album) references album (id)
);

create trigger if not exists track_del after delete on track
begin
  delete from media where id = old.id;
end;

----------------------------------------------------------------

create view if not exists addTrack
  (sonosUrl, album, seq, file, title, artist) as select 0,0,0,0,0,0 where 0;
create trigger if not exists addTrack_sproc instead of insert on addTrack

begin
  insert or ignore into media (type, sonosUrl)
    select  id, new.sonosUrl
      from  mediaType
      where name = 'track';

  insert into track
    (id, album, seq, file, title, artist)
    select a.id, new.album, new.seq, new.file, new.title, new.artist
      from media a
      where a.sonosUrl = new.sonosUrl;

end;

----------------------------------------------------------------

create view if not exists albumTracks as
  select  a.id as albumId,
          b.id as trackId,
          a.path,
          c.sonosUrl

    from  album a
    join  track b on b.album = a.id
    join  media c on c.id = b.id
    order by a.path, b.seq;


----------------------------------------------------------------
----------------------------------------------------------------
-- albums
--
-- which dynamically build tracks from metadata

create table if not exists album (
  id            integer primary key,
  path          text,       -- relative to jonos
  hash          text,       -- hash of the metadata file
  title         text,
  artist        text,
  genre         text,
  cover         text,       -- file with artwork, relative to this
  metadata      blob,       -- JSONB of metadata
  unique (path)
);
create trigger if not exists album_ins after insert on album
begin 
  update album
    set metadata = jsonb(new.metadata)
    where id = new.id;
end;

create trigger if not exists album_del after delete on album
begin
  delete from track
    where album = old.id;
end;

create trigger if not exists album_upd after update of metadata on album
begin
  update album
    set title   = metadata ->> '$.album',
        artist  = metadata ->> '$.albumArtist',
        genre   = metadata ->> '$.genre',
        cover   = ifnull(metadata ->> '$.cover', 'cover.jpg')
    where id = new.id;

  delete from track where album = new.id;

  insert into addTrack (sonosUrl, album, seq, file, title, artist)
    select 
      concat(b.cifsPrefix, new.path, '/', a.value ->> '$.file'),
      new.id,
      a.key,
      a.value ->> '$.file',
      a.value ->> '$.title',
      a.value -> '$.artist'
    from
      json_each(new.metadata -> '$.tracks') a,
      settings b;

end;


----------------------------------------------------------------
--
-- Static details of each player

create table if not exists player (
  id            integer primary key,
  uuid          text not null,
  fullName      text not null,
  url           text not null,
  model         text,
  name          text generated always as (
                  lower(replace(fullName, ' ', ''))
                ),
  unique (uuid),
  unique (url)
);

create trigger if not exists player_ins
  after insert on player
begin
  insert or ignore into playerStatus (id) values (new.id);

  insert or ignore into media (type, sonosUrl)
    select  id, prefix || new.uuid
      from  mediaType
      where name = 'follow';

  insert or ignore into media (type, sonosUrl)
    select  id, prefix || new.uuid || '#0'
      from  mediaType
      where name = 'queue';

  insert or ignore into queue (id, player)
    select  a.id, new.id
      from  media a
      join  mediaType b on b.id = a.type
      where a.sonosUrl = b.prefix || new.uuid || '#0'
        and b.name = 'queue';

end;

create trigger if not exists player_del
  after delete on player
begin
  delete from playerStatus where id = old.id;
  delete from queue where player = old.id;
end;

----------------------------------------------------------------
----------------------------------------------------------------
--
-- volatile details  of each player
--

create table if not exists playerStatus (
  id          integer primary key,
  leader      integer,
  volume      integer,
  mute        integer,
  playState   text,
  playMode    text,
  media       integer,  -- media id of current item
  foreign key (id) references player (id),
  foreign key (leader) references player (id),
  foreign key (media) references media(id)
);

----------------------------------------------------------------
--

drop view if exists playerEx;
create view if not exists playerEx as
  select  a.id,
          a.name,
          c.name as leader,
          b.volume,
          b.mute,
          b.playState in  ('PLAYING', 'TRANSITIONING') as playing,
          b.playMode in ('REPEAT', 'REPEAT_ALL') as repeat,
          d.sonosUrl,
          e.metadata,
          f.items
    from  player a
    join  playerStatus b on b.id = a.id
    join  player c on c.id = b.leader
    join  media d on d.id = b.media
    join  mediaMetadata e on e.id = d.id
    join  queueEx f on f.player = a.id;

----------------------------------------------------------------
----------------------------------------------------------------

create table if not exists queue (
  id      integer primary key not null,
  player  integer not null unique,
  items   text, -- JSON list of media ids

  foreign key (id) references media (id),
  foreign key (player) references player(id)
);

----------------------------------------------------------------

drop view if exists queueEx;
create view if not exists queueEx as
  with urls as (
    select  a.id,
            json_group_array(c.sonosUrl) as items
      from  queue a
      join  json_each(a.items) b
      join  media c on c.id = b.value
      group by 1
  )
  select  a.id,
          a.player,
          b.name,
          c.items
    from queue a
    join player b on b.id = a.player
    left join urls c on c.id = a.id;
----------------------------------------------------------------
-- Permanent table of transient tasks

create table if not exists task (
  id        integer primary key not null,
  player    integer,
  cmd       text not null,
  p1        any,
  p2        any,
  foreign key (player) references player (id)
);

----------------------------------------------------------------
--
create view if not exists addTask (player, cmd, p1, p2)
  as select 0,0,0,0 where 0;
create trigger if not exists addTask_sproc
  instead of insert on addTask
begin
  insert into task (player, cmd, p1, p2)
    select  a.id, new.cmd, new.p1, new.p2
      from  player a
      where a.name = new.player
        or  a.id = new.player
      limit 1;
end;

----------------------------------------------------------------
--

create view if not exists nextTask as
  select  a.id,
          b.name as player,
          a.cmd,
          a.p1,
          a.p2
    from  task a
    join  player b on b.id = a.player
    order by a.id
    limit 1;

----------------------------------------------------------------
--
-- Notify settings

create table if not exists notify (
  id          integer primary key not null,
  name        text not null unique,
  title       text,
  leader      text,
  url         text,
  volume      integer,
  resume      integer
);

insert or ignore into notify (name, title, leader, url, volume, resume )
values
(
  'downstairs', 'Downstairs', 'bookroom',
  'https://media-readersludlow.s3-eu-west-1.amazonaws.com/public/come-downstairs.mp3',
  50, false
),
(
  'feed_us', 'Feed Us', 'bookroom',
  'https://media-readersludlow.s3.eu-west-1.amazonaws.com/public/feed-us-now.mp3',
  50, true
),
(
  'test', 'Test', 'study',
  'https://media-readersludlow.s3.eu-west-1.amazonaws.com/public/feed-me-now.mp3',
  15, true
);


----------------------------------------------------------------
----------------------------------------------------------------
--
-- Presets

create table if not exists preset (
  id          integer primary key,
  name        text not null unique,
  title       text,
  leader      text not null,
  volumes     text not null
);

insert or ignore into preset (name, title, leader, volumes)
values
  ( 'standard', 'Standard', 'bookroom', json_object(
      'bookroom', 25,
      'bedroom', 25,
      'parlour', 25,
      'kitchen', 25,
      'archive', 18,
      'study', 12,
      'diningroom', 12
  )),
  ( 'zoom', 'Zoom', 'bookroom', json_object(
      'bookroom', 25,
      'bedroom', 25,
      'kitchen', 25,
      'archive', 18,
      'diningroom', 12
  )),
  ( 'guests', 'Guests', 'bookroom', json_object(
      'bookroom', 15,
      'bedroom', 50,
      'parlour', 12,
      'kitchen', 50,
      'archive', 50,
      'study', 10,
      'diningroom', 10
  ));
----------------------------------------------------------------

create view if not exists presetEx as
  select  a.name,
          a.leader,
          b.key as player,
          b.value as volume
    from  preset a
    join  json_each(a.volumes) b;

----------------------------------------------------------------
----------------------------------------------------------------
create view if not exists mediaMetadata as
  with cteTracks as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', c.sonosUrl,
              'type', d.name,
              'albumId', b.id,
              'albumArtist', b.artist,
              'album', b.title,
              'genre', b.genre,
              'title', a.title,
              'seq', a.seq
            ) as metadata
      from  track a
      join  album b on b.id = a.album
      join  media c on c.id = a.id
      join  mediaType d on d.id = c.type
  ),
  cteRadio as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', b.sonosUrl,
              'type', c.name,
              'title', a.title,
              'nowPlaying', a.nowPlaying
            ) as metadata
      from  radio a
      join  media b on b.id = a.id
      join  mediaType c on c.id = b.type
  ),
  cteOther as (
    select  a.id,
            json_object(
              'id', a.id,
              'url', a.sonosUrl,
              'type', b.name
            ) as metadata
      from  media a
      join  mediaType b on b.id = a.type
      where a.id not in (select id from track)
        and a.id not in (select id from radio)
  )
  select  id, metadata from cteTracks
  union all
  select  id, metadata from cteRadio
  union all
  select  id, metadata from cteOther;


----------------------------------------------------------------
--
drop view if exists playerState;
create view if not exists playerState as
  with isLeader as (
    select  id, id = leader as isLeader
      from  playerStatus
  )
  select  a.id,
          a.name,
          jsonb_object(
            'id', a.id,
            'name', a.name,
            'leader', a.leader,
            'volume', a.volume,
            'mute', json(iif(a.mute, 'true', 'false')),
            'playing', iif(b.isLeader, jsonb(iif(a.playing, 'true', 'false')), null),
            'repeat', iif(b.isLeader, jsonb(iif(a.repeat, 'true', 'false')), null),
            'current', iif(b.isLeader, jsonb(a.metadata), null),
            'queue', iif(b.isLeader, jsonb(a.items), null)
          ) as state
    from  playerEx a
    join  isLeader b on b.id = a.id;


----------------------------------------------------------------


----------------------------------------------------------------
--
create view if not exists systemState as
  with playerStates as (
    select  name,
            jsonb_object(
              'fullName', fullName,
              'uuid', uuid,
              'url', url,
              'model', model
            ) as state
      from  player
  ),
  presets as (
    select json_group_object(name, title) as state
      from preset
  ),
  notifies as (
    select json_group_object(name, title) as state
    from notify
  ),
  players as (
    select json_group_object(name, json(state)) as state
      from playerStates
  )
  select  json_object(
            'version', a.version,
            'started', strftime('%FT%TZ', a.started),
            'listeners', a.listeners,
            'presets', jsonb(c.state),
            'notifies', jsonb(d.state),
            'players', jsonb(b.state)
          ) as state
    from  systemStatus a,
          players b,
          presets c,
          notifies d;

----------------------------------------------------------------
--

create view if not exists state as
  with players as (
    select  json_group_object(name, json(state)) as state
      from  playerState
  )
  select  json_object(
            'system', jsonb(a.state),
            'players', jsonb(b.state)
          ) as state
    from  systemState a,
          players b;
`

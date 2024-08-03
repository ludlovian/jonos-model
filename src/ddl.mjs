export default `
----------------------------------------------------------------

savepoint main_ddl;
----------------------------------------------------------------
--
--  The main Jonos database
--
--  This is where the player status and settings are held
--
--  More static items are in two attached databases
--    - library.db    - which holds the media metadata
---   - artwork.db    - which holds the artwork
--
----------------------------------------------------------------
--
--  This is the permanent database DDL
--
--  There is also a runtime DDL created in the temp db with
--  stored procs and triggers
--
----------------------------------------------------------------
--
--  This schema table is for the who set of three interlinked
--  databases
--
create table if not exists schema (
  id        integer primary key not null check (id = 1),
  version   integer not null
);
insert or ignore into schema values(1, 2);

----------------------------------------------------------------
--
-- settings table, with a row for each setting
--
--

create table if not exists settings (
  id                integer primary key not null,
  item              text not null,
  value             any,
  unique (item)
);

insert or ignore into settings (item, value)
values
  ('libraryDb',       'db/library.db'),
  ('artworkDb',       'db/artwork.db'),
  ('cifsPrefix',      'x-file-cifs://pi2.local/data/'),
  ('libraryRoot',     'library/files'),
  ('idleTimeout',     10_000),
  ('logEvents',       0);

----------------------------------------------------------------
--
-- Presets
--
create table if not exists housekeeping (
  id          integer primary key not null,
  type        text not null,
  seq         integer not null,
  sql         text not null,
  unique (type, seq)
);

insert or ignore into housekeeping (type,seq,sql)
values
  ('start',10,'update systemStatus set value=''{{VERSION}}'' where item=''version'''),
  ('start',20,'update systemStatus set value=0 where item=''listeners'''),
  ('start',30,'update systemStatus set value=0 where item=''listening'''),
  ('start',40,'update systemStatus set value=strftime(''%FT%TZ'',''now'') where item=''started'''),
  ('start',50,'delete from command'),
  ('start',60,'delete from playerChange'),
  ('start',70,'delete from player'),

  ('idle',10,'delete from playerChange where timestamp<julianday(''now'',''-1 day'')');

----------------------------------------------------------------
--
-- Presets
--

create table if not exists preset (
  id          integer primary key not null,
  name        text not null,
  title       text,
  leader      text not null,
  volumes     text not null,
  unique (name)
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
--
-- Notifies table

create table if not exists notify (
  id          integer primary key not null,
  name        text not null,
  title       text,
  leader      text,
  url         text,
  volume      integer,
  resume      integer,
  unique (name)
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
-- System status table
--
-- A key/value table for various attributes about the current system
--

create table if not exists systemStatus (
  id        integer primary key not null,
  item      text not null,
  value     any,
  unique(item)
);
insert or ignore into systemStatus (item)
values
  ('started'),
  ('version'),
  ('listeners'),
  ('listening');



----------------------------------------------------------------
--
-- The Player
--
-- This is the heart of the DB, and the most volatile table
--
-- Some columns are derived via trigger and denormalised onto the
-- row, which makes the update and change tracking process much easier

create table if not exists player (
  -- static attributes
  id          integer primary key,
  uuid        text not null,
  fullName    text not null,
  url         text not null,
  model       text,
  name        text generated always as
                (lower(replace(fullName, ' ', ''))) stored,

  -- dynamic attributes
  leaderId    integer,
  volume      integer,
  mute        integer,
  playState   text,
  playMode    text,
  mediaId     integer,    -- id of the media for this url
  queueIds    text,       -- JSON array of media ids
  nowStream   text,

  -- derived (denormalised) attributes
  isLeader    integer,    -- leaderId derived
  playing     integer,    -- playState derived
  repeats     integer,    -- playMode derived
  leaderName  text,       -- leaderId expanded
  media       text,       -- mediaId expanded to metadata
  queue       text,       -- queueIds expanded to be an array of metadatas

  unique (uuid),
  unique (url),
  unique (name),
  foreign key (leaderId) references player(id)
  -- foreign key (mediaId) references media(id)
);

----------------------------------------------------------------
--
-- player changes
--
-- Records player changes in a KV list
--
-- If the player is NULL, that implies a change in system status
--

create table if not exists playerChange (
  id          integer primary key not null,
  player      integer,
  key         text,
  value       any,
  timestamp   real,         -- julianday
  foreign key (player) references player(id)
);

----------------------------------------------------------------
--
--  playerChangeEx
--
--  a nicer view of the changes
--

create view if not exists playerChangeEx as
  select  a.id,
          ifnull(b.name, 'system') as player,
          a.key,
          a.value,
          datetime(a.timestamp, 'localtime', 'subsecond') as timestamp
    from  playerChange a
    left join player b on b.id = a.player;


----------------------------------------------------------------
--
-- The command table for queueing commands to a player
--
--

create table if not exists command (
  id          integer primary key not null,
  player      integer not null,
  cmd         text not null,
  parms       text,
  foreign key (player) references player (id)
);

----------------------------------------------------------------
--
--  A nicer view of the command table
--

create view if not exists commandEx as
  select  a.id,
          b.name as player,
          a.cmd,
          a.parms
    from  command a
    join  player b on b.id = a.player;

----------------------------------------------------------------
--
-- The event log table if we are logging events
--
create table if not exists eventLog (
  id          integer primary key not null,
  player      integer,        -- null = 'system' event
  event       text,
  data        text,
  timestamp   real
);

create view if not exists eventLogEx as
  select  a.id,
          ifnull(b.name, 'system') as player,
          a.event,
          a.data,
          datetime(a.timestamp, 'localtime', 'subsec') as timestamp
    from  eventLog a
    left join player b on b.id = a.player;

--
--
----------------------------------------------------------------
--
--  The complete current state for the sytem in a vertical
--  table with
--      - player / 'system'
--      - key
--      - value
--

create view if not exists currentState as
  with lastChange (id) as
  (
    select ifnull(max(id),0) as id from playerChange
  ),
  playerKeys (key) as (
    values
      ('id'),('name'),('uuid'),('fullName'),('url'),('model'),
      ('leaderName'),('volume'),('mute'),('playing'),('media'),
      ('queue'),('nowStream')
  ),
  playerState (id, player, key, value) as 
  (
    select  c.id,
            a.name,
            b.key,
            case b.key
              when 'id'           then a.id
              when 'name'         then a.name
              when 'uuid'         then a.uuid
              when 'fullName'     then a.fullName
              when 'url'          then a.url
              when 'model'        then a.model
              when 'leaderName'   then a.leaderName
              when 'volume'       then a.volume
              when 'mute'         then a.mute
              when 'playing'      then a.playing
              when 'media'        then a.media
              when 'queue'        then a.queue
              when 'nowStream'    then a.nowStream
            end as value
      from  player a
      join  playerKeys b
      join  lastChange c
  ),
  systemState (id, player, key, value) as (
    select  b.id,
            'system',
            a.item,
            a.value
      from  systemStatus a
      join  lastChange b
  ),
  presetState (id, player, key, value) as (
    select  b.id,
            'system',
            'presets',
            json_group_object(a.name, a.title) as value
    from    preset a
    join    lastChange b
    group by 1,2,3
  ),
  notifyState (id, player, key, value) as (
    select  b.id,
            'system',
            'notifies',
            json_group_object(a.name, a.title) as value
      from  notify a
      join  lastChange b
      group by 1,2,3
  )
  select * from systemState
  union all
  select * from presetState
  union all
  select * from notifyState
  union all
  select * from playerState
  order by 1;

----------------------------------------------------------------
release main_ddl;

-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`

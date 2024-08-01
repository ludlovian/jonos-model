export default `

begin;
----------------------------------------------------------------
--
-- The media library database
--
--  mediaType
--  media
--  mediaMetadata
--  album
--  track
--  searchMedia
--
-- Designed to be pretty static once loaded
--

----------------------------------------------------------------
create table if not exists mediaType (
  id            integer primary key,
  name          text,
  prefix        text,
  artwork       integer,      -- default art for the type
  unique (name),
  unique (prefix)
  -- foreign key (artwork) references artwork (id)
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
--
-- media items that can be played
--
-- Each is given an unique id
--
-- This table will be often searched on url -> id
--
-- It is also the only table to be regularly updated
-- with the last played timestamp. We deliberatly
-- store this as an 8-bit double so that the size of the
-- record will likely not change.

create table if not exists media (
  id            integer primary key,
  type          integer not null,
  url           text not null,
  title         text,
  played        real default 0.0,
  artwork       integer,
  unique (url)
  -- foreign key (artwork) references artwork(id)
);
create index if not exists media_ix_1 on media (type);

create table if not exists mediaMetadata (
  id            integer primary key,
  metadata      blob,     -- JSON of metadata
  foreign key (id) references media (id)
);

----------------------------------------------------------------
--
--  Media metadata
--
--  when a new media item is created, a new metadata record
--  is added with a basic object
--
--  this can be updated later, but it ensures there is
--  always a 1 <-> 1 link between then tables, especially
--  for dynamically created entries
--

drop trigger if exists media_ins;
create trigger if not exists media_ins after insert on media
begin
  insert into mediaMetadata (id, metadata)
    select  new.id,
            json_object(
              'id', new.id,
              'type', a.name,
              'url', new.url,
              'title', new.title
            )
      from  mediaType a
      where a.id = new.type;
end;

----------------------------------------------------------------
--
--  mediaEx view
--
--  A more user friendly view of a media item
--

drop view if exists mediaEx;
create view if not exists mediaEx as
  select  a.id,
          b.name as type,
          a.url,
          a.title,
          c.metadata,
          a.artwork,
          datetime(a.played, 'localtime') as played
    from  media a
    join  mediaType b on b.id = a.type
    join  mediaMetadata c on c.id = a.id;

----------------------------------------------------------------
--
-- albums
--
-- Most of the media in the library is albums.
--
-- An album has many tracks, each of which is one media item
-- That link is derived from the metadata but stored
-- in a separate albumTracks table
--
-- Building the media metadata from the album is a necessarily
-- separate process. The database side of this is covered by
-- stored procedures, including one temp table.
--
-- See the runtime version of this file
--

create table if not exists album (
  id            integer primary key not null,
  path          text,       -- relative to jonos
  hash          text,       -- hash of the metadata file
  metadata      blob,       -- JSONB of metadata
  unique (path)
);

create table if not exists albumTracks (
  id            integer primary key not null,
  albumId       integer not null,
  seq           integer not null,
  unique (albumId, seq),
  foreign key (id) references media (id),
  foreign key (albumId) references album (id)
);

----------------------------------------------------------------
--
--  Track
--
--  A view of the tracks in the library
create view if not exists track as
  select  a.id,
          a.albumId,
          a.seq,
          b.url,
          b.metadata

    from  albumTracks a
    join  mediaEx b on b.id = a.id;

----------------------------------------------------------------
--
--  searchMeadia
--
--  The FTS search table
--
--  It links the text of albums with the first track
--
--  Theres a handy view to add in the media metadata
--

create virtual table if not exists searchMedia
  using fts5(id, text);

drop view if exists searchMediaEx;
create view if not exists searchMediaEx as
  select  a.id,
          a.text,
          b.metadata
    from  searchMedia a
    join  mediaEx b on b.id = a.id;

----------------------------------------------------------------
commit;

-- vim: ft=sql ts=2 sts=2 sw=2 et
----------------------------------------------------------------
`

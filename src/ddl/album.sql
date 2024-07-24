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



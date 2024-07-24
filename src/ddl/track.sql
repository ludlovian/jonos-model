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

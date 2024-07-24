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

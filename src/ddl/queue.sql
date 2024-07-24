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

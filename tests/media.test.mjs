import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = readFileSync(new URL('../src/lib/media.ts',import.meta.url),'utf8');
const output = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const media = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const file=(name,folder='/影视/豆瓣250',size=100)=>({id:name,accountId:'test',sourceId:'source',mediaKind:'movie',displayName:name,cloudPath:`${folder}/${name}`,size});
test('collection does not merge different films',()=>assert.equal(media.buildMovieWorks([file('肖申克的救赎.1994.mkv'),file('霸王别姬.1993.mkv')]).length,2));
test('dotted title keeps all words',()=>assert.equal(media.titleCandidateOf(file('Game.of.Thrones.S01E01.mkv')),'Game of Thrones'));
test('E01 adjacent to Chinese name',()=>assert.equal(media.episodeOf(file('万国志E01.mkv')),1));
test('numeric episodes use series folder',()=>{const works=media.buildMovieWorks([file('01HD1080p中英字幕.mkv','/影视/示例剧'),file('02HD1080p中英字幕.mkv','/影视/示例剧')]);assert.equal(works.length,1);assert.equal(works[0].title,'示例剧');});
test('Chinese seasons 11 and 20',()=>{assert.equal(media.seasonOf(file('第01集.mkv','/影视/示例剧/第十一季')),11);assert.equal(media.seasonOf(file('第01集.mkv','/影视/示例剧/第二十季')),20);});
test('same episode in two qualities has one episode identity',()=>{const files=[file('示例剧.S01E01.1080p.mkv'),file('示例剧.S01E01.2160p.mkv')];assert.equal(media.uniqueEpisodes(files).length,1);assert.equal(media.buildMovieWorks(files).length,1);});
test('remakes in different years are separate films',()=>assert.equal(media.buildMovieWorks([file('沙丘.1984.mkv'),file('沙丘.2021.mkv')]).length,2));
test('strip extension is idempotent for dotted title',()=>assert.equal(media.stemOf(media.stemOf('Game.of.Thrones.mkv')),'Game.of.Thrones'));
test('a single known episode is a series',()=>assert.equal(media.buildMovieWorks([file('示例剧.S01E01.mkv')])[0].isSeries,true));
test('filename containing 1917 stays a valid title',()=>assert.equal(media.titleCandidateOf(file('1917.2019.mkv')),'1917'));
test('season episode sorting is numeric',()=>{const work=media.buildMovieWorks([file('示例剧.S02E01.mkv'),file('示例剧.S01E10.mkv'),file('示例剧.S01E02.mkv')])[0];assert.deepEqual(work.files.map(media.episodeOf),[2,10,1]);});
test('LRC multiple time stamps and fractional seconds',()=>assert.deepEqual(media.parseSyncedLyrics('[00:01.50][00:03.005]hello'),[{time:1.5,text:'hello'},{time:3.005,text:'hello'}]));
test('numeric film titles like 300 and 12 Monkeys are not series and do not merge',()=>{
  const f1 = file('300.2006.1080p.mkv', '/Movies');
  const f2 = file('12.Monkeys.1995.mkv', '/Movies');
  const f3 = file('8.Mile.2002.mkv', '/Movies');
  const f4 = file('500.Days.of.Summer.2009.mkv', '/Movies');
  assert.equal(media.episodeOf(f1), null);
  assert.equal(media.episodeOf(f2), null);
  assert.equal(media.episodeOf(f3), null);
  assert.equal(media.episodeOf(f4), null);
  assert.equal(media.titleCandidateOf(f1), '300');
  assert.equal(media.titleCandidateOf(f2), '12 Monkeys');
  assert.equal(media.titleCandidateOf(f3), '8 Mile');
  assert.equal(media.titleCandidateOf(f4), '500 Days of Summer');
  const works = media.buildMovieWorks([f1, f2, f3, f4]);
  assert.equal(works.length, 4);
  assert.ok(works.every(w => !w.isSeries));
});
test('EP and Episode formats are recognized as series and merged', () => {
  const ep1 = file('进击的巨人.EP01.1080p.mkv', '/Anime/进击的巨人');
  const ep2 = file('进击的巨人.EP.02.1080p.mkv', '/Anime/进击的巨人');
  const ep3 = file('繁花.Ep03.mkv', '/Dramas');
  const ep4 = file('示例剧.Episode.04.1080p.mkv', '/Series');
  const ep5 = file('进击的巨人.【05】.mkv', '/Anime/进击的巨人');
  assert.equal(media.episodeOf(ep1), 1);
  assert.equal(media.episodeOf(ep2), 2);
  assert.equal(media.episodeOf(ep3), 3);
  assert.equal(media.episodeOf(ep4), 4);
  assert.equal(media.episodeOf(ep5), 5);
  assert.equal(media.titleCandidateOf(ep1), '进击的巨人');
  assert.equal(media.titleCandidateOf(ep2), '进击的巨人');
  assert.equal(media.titleCandidateOf(ep3), '繁花');
  assert.equal(media.titleCandidateOf(ep5), '进击的巨人');
  const titanWorks = media.buildMovieWorks([ep1, ep2, ep5]);
  assert.equal(titanWorks.length, 1);
  assert.equal(titanWorks[0].title, '进击的巨人');
  assert.equal(titanWorks[0].isSeries, true);
  assert.equal(titanWorks[0].files.length, 3);
});
test('Daming Dynasty 1566 episodes merge into a single series work', () => {
  const ep1 = file('大明王朝1566.01.mkv', '/电视剧/大明王朝1566');
  const ep2 = file('大明王朝1566.02.mkv', '/电视剧/大明王朝1566');
  const ep3 = file('大明王朝1566-03.mkv', '/电视剧/大明王朝1566');
  const ep4 = file('大明王朝1566 第四集.mkv', '/电视剧/大明王朝1566');
  assert.equal(media.episodeOf(ep1), 1);
  assert.equal(media.episodeOf(ep2), 2);
  assert.equal(media.episodeOf(ep3), 3);
  assert.equal(media.episodeOf(ep4), 4);
  assert.equal(media.titleCandidateOf(ep1), '大明王朝1566');
  const works = media.buildMovieWorks([ep1, ep2, ep3, ep4]);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, '大明王朝1566');
  assert.equal(works[0].isSeries, true);
  assert.equal(works[0].files.length, 4);
});
test('anti-censorship pinyin de and zhi are converted to proper Chinese characters', () => {
  const f1 = file('豺狼de日子.2024.1080p.mkv', '/Movies');
  const f2 = file('权利zhi歌.S01E01.mkv', '/Series/权利zhi歌');
  assert.equal(media.cleanWorkTitle('豺狼de日子'), '豺狼的日子');
  assert.equal(media.titleCandidateOf(f1), '豺狼的日子');
  assert.equal(media.titleCandidateOf(f2), '权利之歌');
});


test('music search matches folder, local path and cloud path consistently', () => {
  const song = {...file('Song.flac', '/音乐/午后'), mediaKind:'music', remotePath:'/local/Acoustic/Song.flac'};
  for (const query of ['午后', '  SONG  ', 'acoustic', '音乐', '']) assert.equal(media.matchesMusicQuery(song, query), true);
  assert.equal(media.matchesMusicQuery(song, '不存在'), false);
  assert.equal(media.matchesMusicQuery({...song,cloudPath:undefined,remotePath:undefined}, 'song'), true);
});

/* Real names from a Baidu library (2026-10-11): each case once showed one poster per episode or the wrong poster. */
test('episode numbers glued to the resolution tag form one series', () => {
  const folder = '/影视/电视剧/D-《大明王朝1566》DVD9高参压制1080P';
  const files = ['大明王朝1566HD1080P01.mkv', '大明王朝1566HD1080P02.mkv', '大明王朝1566HD1080P46.mkv'].map((name) => file(name, folder));
  assert.deepEqual(files.map(media.episodeOf), [1, 2, 46]);
  const works = media.buildMovieWorks(files);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, '大明王朝1566');
  assert.equal(works[0].isSeries, true);
});

test('SE03.01 names take the show from the season folder', () => {
  const files = [file('SE03.01.mkv', '/影视/电视剧/绝m/绝丨命毒师 第三季'), file('SE04.02.mkv', '/影视/电视剧/绝m/绝丨命毒师 第四季')];
  assert.deepEqual(files.map(media.episodeOf), [1, 2]);
  assert.deepEqual(files.map(media.seasonOf), [3, 4]);
  const works = media.buildMovieWorks(files);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, '绝命毒师');
});

test('seasons filed under different names in one show folder join', () => {
  const english = [1, 2, 3].map((season) => file(`Black.Mirror.S0${season}E01.1080p.mp4`, `/影视/电视剧/黑镜/《黑镜》第${'一二三'[season - 1]}季`));
  const chinese = file('S07E01.mp4', '/影视/电视剧/黑镜/黑镜第七季');
  const works = media.buildMovieWorks([...english, chinese]);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, 'Black Mirror');
  assert.deepEqual(works[0].seasons, [1, 2, 3, 7]);
  const sherlock = media.buildMovieWorks([file('神探夏洛克S01E01.mkv', '/影视/电视剧/神探夏洛克/神探夏洛克S01'), file('神探夏S04E01.mp4', '/影视/电视剧/神探夏洛克/神探夏洛克S04')]);
  assert.equal(sherlock.length, 1);
  assert.equal(sherlock[0].title, '神探夏洛克');
});

test('a collection of first seasons is not mistaken for one show', () => {
  const works = media.buildMovieWorks([
    file('01.mp4', '/影视/2024最高分英美剧/人生复本S1.2024'),
    file('01.mp4', '/影视/2024最高分英美剧/空战群英[S01][2024]'),
    file('01.mp4', '/影视/2024最高分英美剧/老练律师[S01][2024]'),
  ].map((item, index) => ({ ...item, id: `c${index}` })));
  assert.deepEqual(works.map((work) => work.title).sort(), ['人生复本', '空战群英', '老练律师']);
});

test('extras become a specials season sorted last; a long folder name mentioning 特辑 is not extras', () => {
  const works = media.buildMovieWorks([file('01.mp4', '/影视/电视剧/Z-装腔启示录'), { ...file('01.mp4', '/影视/电视剧/Z-装腔启示录/纪录+花絮'), id: 'extra' }]);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, '装腔启示录');
  assert.deepEqual(works[0].seasons, [1, 0]);
  assert.equal(media.seasonLabel(0), '特别篇');
  const friends = file('Friends.S03E01.1080p.mkv', '/影视/电视剧/L 老友记1080P REMUX 1-10季 重聚特辑（1994）【美剧】/Friends.S03.1080p.BluRay');
  assert.equal(media.seasonOf(friends), 3);
});

test('titles lose season words, quality brackets, tags and collection numbers', () => {
  assert.equal(media.titleCandidateOf(file('庆余年（4k）S01E01.mp4', '/影视/电视剧/庆余年/庆余年1+4K')), '庆余年');
  assert.equal(media.titleCandidateOf(file('Arcane Season1.E01.mp4', '/影视/动漫/英雄联盟双城之战 .2021')), 'Arcane');
  assert.equal(media.titleCandidateOf(file('我们与恶的距离第一季.2019.E01.mp4', '/影视/电视剧/我们与恶的距离')), '我们与恶的距离');
  assert.equal(media.titleCandidateOf(file('S02E01.mp4', '/影视/电视剧/【台剧】我们与恶的距离2')), '我们与恶的距离');
  assert.equal(media.titleCandidateOf(file('S01E01.mp4', '/影视/电视剧/神盾局特工第1-7季/第一季')), '神盾局特工');
  assert.equal(media.titleCandidateOf(file('10-死侍.mp4', '/影视/电影系列合集/[X战警 系列]')), '死侍');
  assert.equal(media.titleCandidateOf(file('沉默的羔羊.双语字幕.HR-HDTV.AC3.1024X554.x264-人人影视制作.mkv')), '沉默的羔羊');
});

test('films stay films: sequels, dated parts and same-name remakes look up with their year', () => {
  for (const name of ['唐人街探案3.mkv', '飞驰人生2.mkv', 'Harry.Potter.and.the.Deathly.Hallows.Part.1.2010.mkv', '教父2.The.Godfather.Part.II.1974.mp4']) {
    assert.equal(media.episodeOf(file(name, '/影视/电影')), null, name);
  }
  const ironMan = media.buildMovieWorks(['Iron Man.2008.mp4', 'Iron Man.2010.mp4'].map((name) => file(name, '/影视/钢铁侠 1~3')));
  assert.deepEqual(ironMan.map(media.lookupNameOf), ['Iron Man 2008', 'Iron Man 2010']);
  const parts = media.buildMovieWorks([1, 2, 3].map((part) => file(`美国商业大亨传奇.Part${part}.The.Men.Who.Built.America.Part${part}.中英字幕.mp4`, '/影视/美国商业大亨传奇')));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, '美国商业大亨传奇');
});

test('dialect versions look up the original show; the cache key carries the kind of work', () => {
  const [work] = media.buildMovieWorks([file('繁花沪语版S01E01.mp4', '/影视/电视剧/繁花沪语版')]);
  assert.equal(work.title, '繁花沪语版');
  assert.equal(media.lookupNameOf(work), '繁花');
  assert.equal(media.lookupKeyOf(work), 'tv:繁花');
});

test('an edition stays visible next to the TMDB title', () => {
  const [work] = media.buildMovieWorks([file('繁花沪语版S01E01.mp4', '/影视/电视剧/繁花沪语版')]);
  assert.equal(media.displayTitleOf(work, { title: '繁花' }), '繁花（沪语版）');
  assert.equal(media.displayTitleOf(work), '繁花沪语版');
  const [plain] = media.buildMovieWorks([file('繁花S01E01.mp4', '/影视/电视剧/繁花')]);
  assert.equal(media.displayTitleOf(plain, { title: '繁花' }), '繁花');
});
test('a library film ignores a folder playlist from Files that does not contain it', () => {
  const movie = file('沙丘.2021.mkv');
  const songs = ['a.mp3', 'b.mp3', 'c.mp3'].map((name) => ({ ...file(name, '/音乐'), mediaKind: 'music' }));
  const { queue, work } = media.videoQueue(movie, [movie, file('霸王别姬.1993.mkv')], songs);
  assert.deepEqual(queue.map((item) => item.id), ['沙丘.2021.mkv']);
  assert.equal(work.files[0].id, '沙丘.2021.mkv');
});
test('the Files folder a video was played from is its queue, else its series', () => {
  const episodes = ['示例剧S01E01.mkv', '示例剧S01E02.mkv', '示例剧S01E03.mkv'].map((name) => file(name, '/影视/示例剧'));
  const folder = [file('家庭录像1.mp4', '/下载'), file('家庭录像2.mp4', '/下载')];
  assert.deepEqual(media.videoQueue(folder[1], [], folder).queue, folder);
  const series = media.videoQueue(episodes[1], episodes, folder);
  assert.deepEqual(series.queue.map((item) => item.id), episodes.map((item) => item.id));
  assert.equal(series.work.isSeries, true);
});

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

/* Library review 2026-10-14: season packs, fansub and site tags, sequel years, variety shows, films in parts, numeric titles, album order. */
test('season packs and far-away folders do not decide the season', () => {
  const pack = '/TV/Friends.S01-S10.1080p.BluRay';
  const files = [file('Friends.S03E01.mkv', `${pack}/Season 3`), file('Friends.S05E01.mkv', `${pack}/Season 5`), file('Friends.S05E02.mkv', `${pack}/Season 5`)];
  assert.deepEqual(files.map(media.seasonOf), [3, 5, 5]);
  const works = media.buildMovieWorks(files);
  assert.equal(works.length, 1);
  assert.deepEqual(works[0].seasons, [3, 5]);
  assert.equal(media.uniqueEpisodes(works[0].files).length, 3);
  assert.equal(media.seasonOf(file('01.mkv', '/影视/老友记S01-S10/S03')), 3);
  assert.equal(media.seasonOf(file('01.mkv', '/影视/权力的游戏S1-S8/Season 8')), 8);
  assert.equal(media.seasonOf(file('01.mkv', '/影视/老友记第1-10季')), 1);
  assert.equal(media.titleCandidateOf(file('E01.mkv', '/影视/老友记S01-S10/S03')), '老友记');
  assert.equal(media.seasonOf(file('Friends.S05E01.mkv', '/Users/se7en/TV/Friends/Season 5')), 5);
  assert.equal(media.seasonOf(file('01.mkv', '/Users/se7en/TV/Friends')), 1);
  assert.equal(media.seasonOf(file('01.mkv', '/Volumes/Seagate S2/TV/Friends')), 1);
  assert.equal(media.seasonOf(file('庆余年.S02EP01.mkv', '/影视/电视剧/庆余年')), 2);
});

test('fansub episodes form one series under the show title', () => {
  const names = [
    ['[Sakurato] Shingeki no Kyojin - NN [1080P].mkv', 'Shingeki no Kyojin'],
    ['[桜都字幕组] 葬送的芙莉莲 [NN][1080P][简日双语].mp4', '葬送的芙莉莲'],
    ['[Nekomoe kissaten][Spy x Family][NN][1080p].mp4', 'Spy x Family'],
    ['[LoliHouse] Sousou no Frieren - NN [WebRip 1080p HEVC-10bit AAC SRTx2].mkv', 'Sousou no Frieren'],
    ['[ANi] 葬送的芙莉蓮 - NN [1080P][Baha][WEB-DL][AAC AVC][CHT].mp4', '葬送的芙莉蓮'],
  ];
  for (const [name, title] of names) {
    const files = ['01', '02', '05'].map((number) => file(name.replace('NN', number), '/影视/动漫'));
    assert.deepEqual(files.map(media.episodeOf), [1, 2, 5], name);
    const works = media.buildMovieWorks(files);
    assert.equal(works.length, 1, name);
    assert.equal(works[0].title, title);
    assert.equal(works[0].isSeries, true);
  }
  assert.equal(media.episodeOf(file('葬送的芙莉莲 第05话.mp4', '/影视/动漫/葬送的芙莉莲')), 5);
  // A group tag in front of a film does not make its number an episode.
  assert.equal(media.episodeOf(file('[YTS] Apollo 13 (1995) [1080p].mkv', '/Movies')), null);
  assert.equal(media.episodeOf(file('[Group] 300 [1080p].mkv', '/Movies')), null);
});

test('site and release-group tags in front of a title are dropped', () => {
  const wandering = '【高清影视之家发布 www.HDBTHD.com】流浪地球2[国语配音+中文字幕].The.Wandering.Earth.II.2023.2160p.WEB-DL.mkv';
  assert.equal(media.titleCandidateOf(file('[电影天堂www.dytt89.com]流浪地球2.HD1080p.国语中字.mp4', '/影视')), '流浪地球2');
  assert.equal(media.titleCandidateOf(file(wandering, '/影视')), '流浪地球2');
  assert.equal(media.titleCandidateOf(file('阳光电影www.ygdy8.com.流浪地球2.HD.1080p.国语中字.mkv', '/影视')), '流浪地球2');
  assert.equal(media.buildMovieWorks([file(wandering, '/影视'), file('流浪地球2.2023.2160p.mkv', '/影视')]).length, 1);
  const series = media.buildMovieWorks(['01', '02'].map((number) => file(`[BD影视分享bd2020.com]狂飙.EP${number}.HD1080P.国语中字.mp4`, '/影视')));
  assert.equal(series.length, 1);
  assert.equal(series[0].title, '狂飙');
  // A title that is itself the first bracket stays.
  assert.equal(media.titleCandidateOf(file('[让子弹飞].2010.mkv', '/影视')), '让子弹飞');
  assert.equal(media.titleCandidateOf(file('[让子弹飞] 2010.mkv', '/影视')), '让子弹飞');
  assert.equal(media.titleCandidateOf(file('[流浪地球]2019 1080p.mkv', '/影视')), '流浪地球');
  assert.equal(media.titleCandidateOf(file('【流浪地球2】[国语中字].mp4', '/影视')), '流浪地球2');
  // A group or site in front of a film named by a year.
  assert.equal(media.titleCandidateOf(file('[YTS] 2012 [1080p].mkv', '/Movies')), '2012');
  assert.equal(media.titleCandidateOf(file('[电影天堂www.dytt89.com]2012.BD.1080p.mkv', '/影视')), '2012');
});

test('sequel numbers and years in a title stay; the release year is the last one', () => {
  const names = ['Blade.Runner.2049.2017.1080p.mkv', 'Wonder.Woman.1984.2020.mkv', '1917.2019.mkv', '2046.2004.mkv', '1917.mkv', '2001.A.Space.Odyssey.1968.mkv', 'Toy.Story.3.mkv', 'Iron.Man.2.mkv', '银翼杀手2049.2017.mkv', '让子弹飞2010.mkv'];
  const lookups = names.map((name) => media.lookupNameOf(media.buildMovieWorks([file(name, '/影视/电影')])[0]));
  assert.deepEqual(lookups, ['Blade Runner 2049 2017', 'Wonder Woman 1984 2020', '1917 2019', '2046 2004', '1917', '2001 A Space Odyssey 1968', 'Toy Story 3', 'Iron Man 2', '银翼杀手2049 2017', '让子弹飞 2010']);
  assert.equal(media.buildMovieWorks([file('Blade.Runner.1982.mkv', '/影视/电影'), file('Blade.Runner.2049.2017.mkv', '/影视/电影')]).length, 2);
});

test('variety shows: air dates are episodes, and halves of one episode stay apart', () => {
  const folder = '/综艺/快乐大本营';
  const [dated, ...rest] = media.buildMovieWorks([file('快乐大本营.20230108.mp4', folder, 300), file('快乐大本营.20230101.mp4', folder, 200), file('快乐大本营.20240106.mp4', folder, 100)]);
  assert.equal(rest.length, 0);
  assert.equal(dated.isSeries, true);
  assert.equal(dated.title, '快乐大本营');
  assert.deepEqual(dated.files.map((item) => item.displayName), ['快乐大本营.20230101.mp4', '快乐大本营.20230108.mp4', '快乐大本营.20240106.mp4']);
  assert.equal(media.episodeLabel(dated.files[0], 0), '2023-01-01');
  assert.equal(media.episodeNumberOf(dated.files[0]), null);
  const [dashed] = media.buildMovieWorks(['奔跑吧 2023-10-03.mp4', '奔跑吧 2023-11-03.mp4'].map((name) => file(name, '/综艺/奔跑吧')));
  assert.equal(media.uniqueEpisodes(dashed.files).length, 2);
  // An air date in front of the episode number is not part of the title.
  const numbered = media.buildMovieWorks(['快乐大本营.20230101.第1期.mp4', '快乐大本营.20230108.第2期.mp4'].map((name) => file(name, folder)));
  assert.deepEqual(numbered.map((work) => [work.title, work.files.length]), [['快乐大本营', 2]]);
  const [season] = media.buildMovieWorks(['向往的生活第七季-20230428.mp4', '向往的生活第七季-20230505.mp4'].map((name) => file(name, '/综艺/向往的生活')));
  assert.deepEqual([season.title, season.seasons, season.files.length], ['向往的生活', [7], 2]);
  // A camera's timestamp is not an air date.
  assert.equal(media.episodeOf(file('VID_20230101_123456.mp4', '/影视/家庭录像')), null);
  const [halves] = media.buildMovieWorks(['乘风破浪 第2期上.mp4', '乘风破浪 第1期下.mp4', '乘风破浪 第1期加更.mp4', '乘风破浪 第1期上.mp4'].map((name) => file(name, '/综艺/乘风破浪')));
  const episodes = media.uniqueEpisodes(halves.files);
  assert.deepEqual(episodes.map((item, index) => media.episodeLabel(item, index)), ['第 1 期上', '第 1 期下', '第 1 期加更', '第 2 期上']);
  assert.ok(episodes.every((item) => media.episodeNumberOf(item) === null));
  const spaced = ['乘风破浪 第1期 上.mp4', '乘风破浪 第1期 下.mp4'].map((name) => file(name, '/综艺/乘风破浪'));
  assert.equal(media.uniqueEpisodes(spaced).length, 2);
  assert.equal(media.episodeLabel(file('乘风破浪 第3期.mp4', '/综艺/乘风破浪'), 0), '第 3 期');
  assert.equal(media.episodeNumberOf(file('乘风破浪 第3期.mp4', '/综艺/乘风破浪')), 3);
  // "上海" after 第1集 begins the episode's name; it is not the first half.
  assert.equal(media.episodeOf(file('繁花 第1集上海往事.mp4', '/影视/电视剧/繁花')), 1);
});

test('a film on two discs is one work that starts with CD1; trailers, samples and featurettes are not works', () => {
  const cases = [[['让子弹飞.2010.CD1.mkv', '让子弹飞.2010.CD2.mkv'], '/影视/电影'], [['让子弹飞.CD1.mkv', '让子弹飞.CD2.mkv'], '/影视/电影'], [['CD1.mkv', 'CD2.mkv'], '/影视/电影/让子弹飞 2010'], [['让子弹飞.2010.Part1.mkv', '让子弹飞.2010.Part2.mkv'], '/影视/电影']];
  for (const [[first, second], folder] of cases) {
    const works = media.buildMovieWorks([file(second, folder, 900), file(first, folder, 700)]);
    assert.equal(works.length, 1, first);
    assert.equal(works[0].title, '让子弹飞');
    assert.equal(works[0].isSeries, false);
    assert.equal(works[0].files[0].displayName, first);
    assert.equal(media.versionCountOf(works[0]), 1);
  }
  const [copies] = media.buildMovieWorks([file('让子弹飞.2010.CD2.mkv', '/影视/电影', 900), file('让子弹飞.2010.CD1.mkv', '/影视/电影', 700), file('让子弹飞.2010.2160p.mkv', '/影视/电影', 9000)]);
  assert.deepEqual(copies.files.map((item) => item.displayName), ['让子弹飞.2010.2160p.mkv', '让子弹飞.2010.CD1.mkv', '让子弹飞.2010.CD2.mkv']);
  assert.equal(media.versionCountOf(copies), 2);
  assert.equal(media.episodeOf(file('让子弹飞.Disc.02.mkv', '/影视/电影')), null);
  const folder = '/Movies/Inception (2010)';
  const works = media.buildMovieWorks([
    file('Inception.2010.1080p.mkv', folder, 9000),
    file('Inception.2010.sample.mkv', folder, 50),
    file('Inception-trailer.mkv', folder),
    file('Behind the Scenes.mkv', `${folder}/Featurettes`),
    file('Deleted Scene 1.mkv', `${folder}/Deleted Scenes`),
    file('Teaser.mkv', `${folder}/Trailers`),
  ]);
  assert.deepEqual(works.map((work) => [work.title, work.files.length]), [['Inception', 1]]);
});

test('shows named by a number keep it as their title', () => {
  const shows = [['1883.S01E0N.1080p.mkv', '/影视/1883', '1883'], ['24.S01E0N.mkv', '/影视/24', '24'], ['1923.S01E0N.mkv', '/影视/1923 (2022)', '1923'], ['1883.S01E0N.mkv', '/TV/1883/Season 1', '1883']];
  for (const [name, folder, title] of shows) {
    const works = media.buildMovieWorks([1, 2, 3].map((number) => file(name.replace('N', number), folder)));
    assert.equal(works.length, 1, folder);
    assert.equal(works[0].title, title);
    assert.equal(works[0].isSeries, true);
  }
  // A number in front of the episode is not the title when the show folder names it.
  assert.equal(media.titleCandidateOf(file('2019.E01.mkv', '/影视/示例剧')), '示例剧');
});

test('a leading track number is not the artist, and albums sort by track', () => {
  const song = (name, folder = '/音乐/Adele/25') => ({ ...file(name, folder), mediaKind: 'music' });
  const parts = (name) => { const { artist, title, track } = media.songParts(song(name)); return [artist, title, track]; };
  assert.deepEqual(parts('01 - Adele - Hello.flac'), ['Adele', 'Hello', 1]);
  assert.deepEqual(parts('01 - Speak to Me.flac'), ['', 'Speak to Me', 1]);
  assert.deepEqual(parts('02. Hello.flac'), ['', 'Hello', 2]);
  assert.deepEqual(parts('周杰伦 - 晴天.mp3'), ['周杰伦', '晴天', undefined]);
  assert.deepEqual(parts('99 Luftballons.flac'), ['', '99 Luftballons', undefined]);
  assert.deepEqual(parts('311 - Amber.flac'), ['311', 'Amber', undefined]);
  const album = ['03 - Adele - I Miss You.flac', '01 - Adele - Hello.flac', '02 - Adele - Send My Love.flac'].map((name) => song(name));
  assert.deepEqual(album.sort(media.compareAlbumOrder).map((item) => item.displayName.slice(0, 2)), ['01', '02', '03']);
  const discs = [song('02 - Breathe.flac', '/音乐/The Wall/CD1'), song('01 - Wish You Were Here.flac', '/音乐/WYWH/CD1'), song('01 - Speak to Me.flac', '/音乐/The Wall/CD1')];
  assert.deepEqual(discs.map(media.musicFolderOf), ['The Wall › CD1', 'WYWH › CD1', 'The Wall › CD1']);
  assert.deepEqual(discs.sort(media.compareAlbumOrder).map((item) => item.displayName), ['01 - Speak to Me.flac', '02 - Breathe.flac', '01 - Wish You Were Here.flac']);
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

test('artists come from the file name, split on joint credits, merged across spellings', () => {
  const song = (name) => ({ ...file(name, '/普听音乐/音乐库/音乐'), mediaKind: 'music' });
  const songs = ['BEYOND - 海阔天空.flac', 'BY2 - 爱的双重魔力.flac', 'By2 - 爱丫爱丫.wav', 'Charlie Puth,Selena Gomez - We Don\'t Talk Anymore.flac', '无名曲.mp3'].map(song);
  assert.deepEqual(media.artistsOfSong(songs[3]), ['Charlie Puth', 'Selena Gomez']);
  assert.deepEqual(media.artistsOfSong(song('A & B feat. C - Song.mp3')), ['A', 'B', 'C']);
  assert.deepEqual(media.artistsOfSong(songs[4], { artist: '某歌手' }), ['某歌手']);
  const artists = media.groupArtists(songs, new Map());
  assert.deepEqual(artists.map((artist) => [artist.name, artist.songs.length]), [['BEYOND', 1], ['BY2', 2], ['Charlie Puth', 1], ['Selena Gomez', 1], ['未知艺人', 1]]);
});

test('albums come from looked-up details; same-named albums with different covers stay apart', () => {
  const song = (name) => ({ ...file(name, '/音乐'), mediaKind: 'music' });
  const songs = ['BEYOND - 海阔天空.flac', 'BEYOND - 光辉岁月.flac', 'X - Hits.mp3', 'Y - Hits.mp3', 'Z - 未查.mp3'].map(song);
  const info = new Map([
    [songs[0].id, { album: '乐与怒', artworkUrl: 'a.jpg' }],
    [songs[1].id, { album: '乐与怒', artworkUrl: 'a.jpg' }],
    [songs[2].id, { album: 'Greatest Hits', artworkUrl: 'x.jpg' }],
    [songs[3].id, { album: 'Greatest Hits', artworkUrl: 'y.jpg' }],
  ]);
  const { albums, unknown } = media.groupAlbums(songs, info);
  assert.equal(unknown, 1);
  assert.deepEqual(albums.map((album) => [album.title, album.artist, album.songs.length]), [['乐与怒', 'BEYOND', 2], ['Greatest Hits', 'X', 1], ['Greatest Hits', 'Y', 1]]);
});

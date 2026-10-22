import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const output = ts.transpileModule(readFileSync(new URL('../src/lib/courses.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const courses = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const source = (id, remoteRoot, label) => ({ id, accountId: 'baidu', kind: 'course', remoteRoot, label, lastScanAt: null });
const file = (path, sourceId = 'all') => ({ id: path, accountId: 'baidu', remotePath: path, cloudPath: path, displayName: path.split('/').pop(), size: 1, sourceId, sourceIds: [sourceId], mediaKind: 'course' });

/* Real course folders from a Baidu drive (2026-10-22). */
const all = source('all', '/大模型', '大模型');
const files = [
  '/大模型/咕泡-AI人工智能深度学习系统班14期/07-【方向A：CV方向】图像分割算法/11.SAM 图像分割算法/2-论文解读分析.mp4',
  '/大模型/咕泡-AI人工智能深度学习系统班14期/07-【方向A：CV方向】图像分割算法/9.MaskRcnn网络框架源码详解/1-FPN层的作用.mp4',
  '/大模型/咕泡-AI人工智能深度学习系统班14期/07-【方向A：CV方向】图像分割算法/11.SAM 图像分割算法/1-DEMO效果演示.mp4',
  '/大模型/机器学习量化实战/视频教程/第02章节、量化交易系统综述.mp4',
  '/大模型/机器学习量化实战/视频教程/第01章节、自动化交易综述.mp4',
  '/大模型/机器学习量化实战/课件/第01章 讲义.pdf',
  '/大模型/【金程教育】【Python基础+量化进阶】基于Python的量化学习/01量化投资前导及课程介绍/1.AQF核心课程知识体系.mp4',
].map((path) => file(path));

test('a folder of courses becomes one course per subfolder, chapters in natural order', () => {
  const list = courses.buildCourses(files, [all]);
  // Pinyin order: 咕 (gū), 机 (jī), 基 (jī).
  assert.deepEqual(list.map((course) => course.title), ['咕泡-AI人工智能深度学习系统班14期', '机器学习量化实战', '基于Python的量化学习']);
  const cv = list.find((course) => course.title.startsWith('咕泡'));
  assert.deepEqual(cv.chapters.map((chapter) => chapter.title), [
    '07-【方向A：CV方向】图像分割算法 › 9.MaskRcnn网络框架源码详解',
    '07-【方向A：CV方向】图像分割算法 › 11.SAM 图像分割算法',
  ]);
  assert.deepEqual(cv.lessons.map((lesson) => lesson.displayName), ['1-FPN层的作用.mp4', '1-DEMO效果演示.mp4', '2-论文解读分析.mp4']);
  const quant = list.find((course) => course.title === '机器学习量化实战');
  assert.deepEqual(quant.chapters.map((chapter) => chapter.title), ['']);
  assert.deepEqual(quant.materialChapters.map((chapter) => chapter.title), ['课件']);
  assert.equal(quant.lessons[0].displayName, '第01章节、自动化交易综述.mp4');
  assert.equal(quant.materials.length, 1);
  const school = list.find((course) => course.title === '基于Python的量化学习');
  assert.deepEqual(school.tags, ['金程教育', 'Python基础+量化进阶']);
  assert.equal(school.folder, '/大模型/【金程教育】【Python基础+量化进阶】基于Python的量化学习');
});

test('a single course folder is one course whose subfolders are chapters', () => {
  const one = source('one', '/大模型/【金程教育】基于Python的量化学习', '基于Python的量化学习');
  const lessons = ['01量化投资前导/1.课程介绍.mp4', '02Python基础/1.变量.mp4', '02Python基础/10.函数.mp4', '02Python基础/2.循环.mp4']
    .map((path) => file(`/大模型/【金程教育】基于Python的量化学习/${path}`, 'one'));
  const [course] = courses.buildCourses(lessons, [one]);
  assert.equal(course.title, '基于Python的量化学习');
  assert.deepEqual(course.lessons.map((lesson) => lesson.displayName), ['1.课程介绍.mp4', '1.变量.mp4', '2.循环.mp4', '10.函数.mp4']);
});

test('progress continues the lesson begun, or the next after the last finished', () => {
  const [course] = courses.buildCourses(files.slice(0, 3), [all]);
  const saved = (entries) => new Map(entries.map(([id, position, duration, updatedAt]) => [id, { fileId: id, position, duration, updatedAt }]));
  const [a, b, c] = course.lessons;
  assert.equal(courses.courseProgress(course, new Map()).next, null);
  const begun = courses.courseProgress(course, saved([[a.id, 0, 600, 1], [b.id, 120, 600, 2]]));
  assert.equal(begun.next, b);
  assert.equal(begun.resume.position, 120);
  assert.equal(begun.finished.size, 1);
  const moved = courses.courseProgress(course, saved([[b.id, 0, 600, 5]]));
  assert.equal(moved.next, c);
  assert.equal(courses.courseProgress(course, saved([[c.id, 0, 600, 9]])).done, true);
});

test('the number a lesson carries goes in the index column', () => {
  assert.deepEqual(courses.lessonLabel('1.变量与类型'), { number: '1', text: '变量与类型' });
  assert.deepEqual(courses.lessonLabel('03-FPN层的作用'), { number: '3', text: 'FPN层的作用' });
  assert.deepEqual(courses.lessonLabel('第01章节、自动化交易综述'), { text: '第01章节、自动化交易综述' });
  assert.deepEqual(courses.lessonLabel('2024 年度回顾'), { text: '2024 年度回顾' });
});

test('a course folder holding one course names it after that course', () => {
  const holder = source('holder', '/网课', '网课');
  const lessons = ['机器学习量化实战/视频教程/第01章节、综述.mp4', '机器学习量化实战/课件/讲义.pdf'].map((path) => file(`/网课/${path}`, 'holder'));
  const [course] = courses.buildCourses(lessons, [holder]);
  assert.equal(course.title, '机器学习量化实战');
  const chapterOnly = ['01课程介绍/1.开始.mp4'].map((path) => file(`/网课/${path}`, 'holder'));
  assert.equal(courses.buildCourses(chapterOnly, [holder])[0].title, '网课');
});

test('a large course reads by module, and handouts stay apart from the lessons', () => {
  const holder = source('big', '/大模型', '大模型');
  const paths = [
    '黑马程序员/01_Python基础/01.Linux基础/Day01_Linux基础/01.导学.mp4',
    '黑马程序员/01_Python基础/01.Linux基础/Day01_Linux基础/02.今日内容.mp4',
    '黑马程序员/01_Python基础/02.Python入门/Day02/01.变量.mp4',
    '黑马程序员/02_数据分析/01.Numpy/01.数组.mp4',
    '黑马程序员/资料/讲义.pdf',
  ];
  const [course] = courses.buildCourses(paths.map((path) => file(`/大模型/${path}`, 'big')), [holder]);
  assert.deepEqual(course.modules.map((module) => [module.title, module.lessons.length]), [['01_Python基础', 3], ['02_数据分析', 1]]);
  assert.deepEqual(course.modules[0].chapters.map((chapter) => chapter.title), ['01.Linux基础 › Day01_Linux基础', '02.Python入门 › Day02']);
  assert.equal(course.lessons.length, 4);
  assert.deepEqual(course.materialChapters.map((chapter) => [chapter.title, chapter.items.length]), [['资料', 1]]);
});

test('tags at either end of a course name leave the title', () => {
  assert.deepEqual(courses.courseTitle('黑马程序员-2025年python人工智能开发 V5.0【itjc8.com】'), { title: '黑马程序员-2025年python人工智能开发 V5.0', tags: ['itjc8.com'] });
  assert.deepEqual(courses.courseTitle('一【『区块链』从零构建以太坊（Ethereum）智能合约到项目实战】'), { title: '『区块链』从零构建以太坊（Ethereum）智能合约到项目实战', tags: [] });
  assert.deepEqual(courses.courseTitle('金融风控实战【附代码与数据集全套资料】'), { title: '金融风控实战', tags: ['附代码与数据集全套资料'] });
});

test('Chinese numerals order chapters as numbers', () => {
  const names = ['第二十二章 框架', '第八章 字符串', '第一部分 新手入门', '第三部分 财富跃迁', '第二部分 高手进阶', '九月', '八月'];
  const ordered = [...names].sort((left, right) => new Intl.Collator('zh-CN', { numeric: true }).compare(courses.sortKey(left), courses.sortKey(right)));
  assert.deepEqual(ordered, ['八月', '九月', '第一部分 新手入门', '第二部分 高手进阶', '第三部分 财富跃迁', '第八章 字符串', '第二十二章 框架']);
});

test('one top-level folder of many chapters uses its chapters as the contents', () => {
  const holder = source('fin', '/金融', '金融');
  const paths = ['云聪/课程/第一章 入门/1.开始.mp4', '云聪/课程/第一章 入门/2.基础.mp4', '云聪/课程/第二章 进阶/1.进阶.mp4'];
  const [course] = courses.buildCourses(paths.map((path) => file(`/金融/${path}`, 'fin')), [holder]);
  assert.deepEqual(course.modules.map((module) => [module.title, module.lessons.length]), [['第一章 入门', 2], ['第二章 进阶', 1]]);
});

test('website stamps leave lesson titles', () => {
  assert.deepEqual(courses.lessonLabel('02.今日内容大纲介绍【itjc8.com】'), { number: '2', text: '今日内容大纲介绍' });
  assert.deepEqual(courses.lessonLabel('如何安装Vmware软件【itjc8.com】'), { text: '如何安装Vmware软件' });
  assert.deepEqual(courses.lessonLabel('【直播】第一课'), { text: '【直播】第一课' });
});

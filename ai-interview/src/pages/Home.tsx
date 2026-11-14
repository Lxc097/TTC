import { Link } from 'react-router-dom'
import { ArrowUpRight, AudioLines, Camera, ChevronRight, ClipboardList, HeartPulse, LockKeyhole, Play, Sparkles } from 'lucide-react'

export function Home() {
  return <>
    <section className="hero container">
      <div className="hero-copy">
        <div className="hero-pill"><span className="pill-line" />天镜 Practice · AI 面试练习空间</div>
        <h1>把下一次面试，<br /><span>练成你的主场。</span></h1>
        <p className="hero-description">从真实提问、语音作答到逐题复盘，在一个安静专注的空间里，练习更清晰的表达。</p>
        <div className="hero-actions"><Link className="button button-primary button-large" to="/setup"><Play size={18} fill="currentColor" />开始模拟面试<ChevronRight size={18} /></Link><Link className="button button-secondary button-large" to="/join">加入真实面试<ArrowUpRight size={18} /></Link></div>
        <div className="hero-note"><LockKeyhole size={15} />摄像头需经你授权；不保存原始视频</div>
      </div>
      <div className="hero-visual" aria-label="产品交互示意">
        <div className="visual-window">
          <div className="visual-top"><span className="visual-logo"><AudioLines size={15} />天镜面试间</span><span className="visual-status"><span />练习进行中</span></div>
          <div className="visual-progress"><span>模拟面试</span><span>02 / 06</span></div>
          <div className="progress-track"><span style={{width:'35%'}} /></div>
          <div className="visual-question"><div className="avatar-mini"><AudioLines size={22} /></div><span>面试官正在提问</span><h2>介绍一个你解决复杂问题的经历。你是如何定位问题、推动协作并验证结果的？</h2></div>
          <div className="visual-reply"><span className="reply-icon"><Sparkles size={17} /></span><span>先说明背景与目标，再讲你的行动和结果</span></div>
          <div className="visual-bottom"><div><span className="visual-dot" />本地练习模式</div><span>产品界面示意</span></div>
        </div>
        <div className="float-card"><span className="float-icon"><ClipboardList size={18} /></span><div><b>逐题复盘</b><small>让反馈落到具体回答</small></div></div>
      </div>
    </section>
    <section className="features-wrap"><div className="container">
      <div className="section-heading"><div><span className="section-kicker">练习流程</span><h2>从开口练习，到看见进步</h2></div><Link to="/history" className="text-link">我的面试记录 <ArrowUpRight size={17} /></Link></div>
      <div className="feature-grid">
        <article className="feature-card"><span className="feature-icon blue"><Camera size={24} /></span><h3>真实视频预览</h3><p>使用浏览器连接你的摄像头。先确认画面与麦克风，再由你决定是否启用图像分析。</p><span className="feature-index">01 / 03</span></article>
        <article className="feature-card"><span className="feature-icon violet"><AudioLines size={24} /></span><h3>有节奏的模拟面试</h3><p>按岗位、类型和难度提问，支持文字或语音作答，并根据回答内容触发追问。</p><span className="feature-index">02 / 03</span></article>
        <article className="feature-card"><span className="feature-icon teal"><HeartPulse size={24} /></span><h3>分层呈现分析</h3><p>回答评分来自可解释的文本规则。生理信号单独展示；演示模式始终明确标记。</p><span className="feature-index">03 / 03</span></article>
      </div>
    </div></section>
  </>
}

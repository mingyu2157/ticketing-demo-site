import React, { useState } from 'react';
import Header from './components/Header';
import ShowCard from './components/ShowCard';
import ShowDetail from './components/ShowDetail';
import QueueModal from './components/QueueModal';
import CaptchaModal from './components/CaptchaModal';
import SeatMapModal from './components/SeatMapModal';
import PaymentModal from './components/PaymentModal';
import SuccessModal from './components/SuccessModal';
import CaptchaTestPage from './components/CaptchaTestPage';
import { SHOWS, getShowById } from './data/shows';

export default function App() {
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  const isCaptchaTestPath = pathname === '/captcha-test';

  if (isCaptchaTestPath) {
    return <CaptchaTestPage />;
  }

  return <TicketingApp />;
}

function TicketingApp() {
  const [view, setView] = useState('home'); // 'home' | 'detail'
  const [selectedShowId, setSelectedShowId] = useState(null);
  const [booking, setBooking] = useState(null);
  const [modal, setModal] = useState(null); // null | 'captcha' | 'seatmap' | 'queue' | 'payment' | 'success'

  const goHome = () => {
    setView('home');
    setSelectedShowId(null);
    setModal(null);
    setBooking(null);
    window.scrollTo(0, 0);
  };

  const openShow = (id) => {
    setSelectedShowId(id);
    setView('detail');
    window.scrollTo(0, 0);
  };

  const handleStartBooking = (info) => {
    setBooking(info);
    setModal(info.show.captchaRequired ? 'captcha' : 'seatmap');
  };

  const handleSeatsConfirmed = (seats) => {
    setBooking((prev) => ({
      ...prev,
      selectedSeats: seats,
      totalQty: seats.length,
      totalPrice: seats.reduce((sum, s) => sum + s.price, 0),
    }));
    setModal('payment');
  };

  const selectedShow = selectedShowId ? getShowById(selectedShowId) : null;

  return (
    <div className="tk-app">
      <Header onHome={goHome} />

      {view === 'home' && (
        <div className="tk-wrap">
          <section className="tk-hero">
            <span className="tk-hero-eyebrow">TICKETON PICK</span>
            <h1>오늘 열리는 공연을 한눈에</h1>
            <p>콘서트부터 전시, 스포츠까지 티켓온에서 빠르게 예매하세요.</p>
            <button
            className="tk-hero-btn"
            type="button"
            onClick={() => {
              const el = document.getElementById('popular-shows');
              if (el) {
                const top = el.getBoundingClientRect().top + window.scrollY - 90;
                window.scrollTo({ top, behavior: 'smooth' });
              }
            }}
          >
            인기 공연 보기 →
          </button>
          </section>

          <div className="tk-section-head" id="popular-shows">
            <h2>지금 인기 있는 공연</h2>
            <span>전체보기</span>
          </div>
          <div className="tk-grid">
            {SHOWS.map((show) => (
              <ShowCard key={show.id} show={show} onSelect={openShow} />
            ))}
          </div>
        </div>
      )}

      {view === 'detail' && selectedShow && (
        <ShowDetail show={selectedShow} onBack={goHome} onStartBooking={handleStartBooking} />
      )}

      {modal === 'captcha' && booking && (
        <CaptchaModal
          booking={booking}
          onCancel={() => setModal(null)}
          onVerified={() => setModal('queue')}
        />
      )}

      {modal === 'queue' && booking && (
        <QueueModal
          booking={booking}
          onCancel={() => setModal(null)}
          onEnter={() => setModal('seatmap')}
        />
      )}

      {modal === 'seatmap' && booking && (
        <SeatMapModal
          show={booking.show}
          date={booking.date}
          time={booking.time}
          initialSelected={booking.selectedSeats || []}
          onCancel={() => setModal(null)}
          onConfirm={handleSeatsConfirmed}
        />
      )}

      {modal === 'payment' && booking && (
        <PaymentModal
          booking={booking}
          onCancel={() => setModal(null)}
          onPay={() => setModal('success')}
        />
      )}

      {modal === 'success' && booking && (
        <SuccessModal
          booking={booking}
          onClose={goHome}
          onGoToConfirm={goHome}
        />
      )}
    </div>
  );
}

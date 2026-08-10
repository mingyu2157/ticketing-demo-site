import React, { useState } from 'react';

export default function Header({ onHome }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header className="tk-header">
      <div className="tk-header-row">
        <button className="tk-logo" type="button" onClick={onHome} aria-label="티켓온 홈으로 이동">
          <b>티켓온</b>
          <span>TICKETON</span>
        </button>
        <div className="tk-search">⌕ 공연, 아티스트, 장소를 검색해 보세요</div>
        <nav className="tk-header-links">
          <a href="#login">로그인</a>
          <a href="#signup">회원가입</a>
          <a href="#mypage">마이페이지</a>
          <a href="#confirm">예매확인</a>
          <a href="#cart">장바구니<span className="tk-cart-badge">0</span></a>
        </nav>
        <div className="tk-mobile-actions">
          <a className="tk-mobile-cart" href="#cart" aria-label="장바구니, 담긴 상품 0개">
            장바구니<span className="tk-cart-badge">0</span>
          </a>
          <button
            className="tk-menu-button"
            type="button"
            aria-label="회원 메뉴 열기"
            aria-expanded={isMenuOpen}
            aria-controls="tk-mobile-menu"
            onClick={() => setIsMenuOpen((open) => !open)}
          >
            <span aria-hidden="true" />
            <span aria-hidden="true" />
            <span aria-hidden="true" />
          </button>
        </div>
        <nav
          id="tk-mobile-menu"
          className={`tk-mobile-menu${isMenuOpen ? ' is-open' : ''}`}
          aria-label="회원 메뉴"
        >
          <a href="#login" onClick={closeMenu}>로그인</a>
          <a href="#signup" onClick={closeMenu}>회원가입</a>
          <a href="#mypage" onClick={closeMenu}>마이페이지</a>
          <a href="#confirm" onClick={closeMenu}>예매확인</a>
        </nav>
      </div>
      <nav className="tk-subnav">
        <a href="#concert">콘서트</a>
        <a href="#musical">뮤지컬</a>
        <a href="#play">연극</a>
        <a href="#exhibit">전시</a>
        <a href="#sports">스포츠</a>
        <a href="#ranking">랭킹</a>
        <a href="#event">이벤트·혜택</a>
        <a href="#region">지역별</a>
      </nav>
    </header>
  );
}

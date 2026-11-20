import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { MarketTick } from '../lib/api';

interface PulseNodeProps {
  baseColor: string;
  position: [number, number, number];
  changePct: number;
}

const BULL_COLOR = new THREE.Color('#16C784');
const BEAR_COLOR = new THREE.Color('#EA3943');
const SCRATCH_COLOR = new THREE.Color();

const PulseNode: React.FC<PulseNodeProps> = ({ baseColor, position, changePct }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const neutralColor = useMemo(() => new THREE.Color(baseColor), [baseColor]);

  const { geometry, material } = useMemo(() => {
    const geo = new THREE.IcosahedronGeometry(0.68, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: baseColor,
      wireframe: true,
      emissive: baseColor,
      emissiveIntensity: 0.25,
    });
    return { geometry: geo, material: mat };
  }, [baseColor]);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  useFrame((state, delta) => {
    if (!meshRef.current) return;
    const step = Math.min(delta, 0.05);
    const speed = 0.4 + Math.min(Math.abs(changePct) * 0.25, 1.4);
    meshRef.current.rotation.y += step * speed;
    meshRef.current.rotation.x += step * 0.25;

    const pulse = 1 + Math.sin(state.clock.elapsedTime * (2.2 + Math.abs(changePct))) * 0.05;
    meshRef.current.scale.setScalar(pulse);

    if (changePct > 0.05) {
      SCRATCH_COLOR.copy(neutralColor).lerp(BULL_COLOR, 0.55);
    } else if (changePct < -0.05) {
      SCRATCH_COLOR.copy(neutralColor).lerp(BEAR_COLOR, 0.55);
    } else {
      SCRATCH_COLOR.copy(neutralColor);
    }
    material.color.copy(SCRATCH_COLOR);
    material.emissive.copy(SCRATCH_COLOR);
  });

  return <mesh ref={meshRef} position={position} geometry={geometry} material={material} />;
};

interface MarketPulse3DProps {
  ticks: Record<string, MarketTick>;
  goldSymbol: string;
  connected: boolean;
}

export const MarketPulse3D: React.FC<MarketPulse3DProps> = ({ ticks, goldSymbol, connected }) => {
  const [lowPower, setLowPower] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    setLowPower(media.matches || window.innerWidth < 640);
  }, []);

  const btc = ticks['BTCUSDT'];
  const eth = ticks['ETHUSDT'];
  const gold = ticks[goldSymbol] ?? ticks['XAUUSDT'] ?? ticks['PAXGUSDT'];

  const items = [
    { symbol: 'BTCUSDT', color: '#F7931A', tick: btc },
    { symbol: 'ETHUSDT', color: '#3B82F6', tick: eth },
    { symbol: goldSymbol, color: '#D4AF37', tick: gold },
  ];

  return (
    <div className="terminal-card rounded p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-[#8B92A0]">
            3D Live Market Core
          </span>
          <span className="text-[11px] font-mono text-[#8B92A0]">
            BTC / ETH / {goldSymbol}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span
            className={`w-2 h-2 rounded-full ${connected ? 'bg-[#16C784]' : 'bg-[#EA3943]'}`}
          />
          <span className="text-[#8B92A0]">{connected ? 'WS LIVE' : 'WS RECONNECTING'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
        <div className="lg:col-span-5 h-[140px] bg-[#0A0B0D] border border-[#22262E] rounded overflow-hidden">
          <Canvas
            dpr={lowPower ? 1 : [1, 1.5]}
            frameloop={lowPower ? 'demand' : 'always'}
            camera={{ position: [0, 0, 4.4], fov: 40 }}
            gl={{ antialias: !lowPower }}
          >
            <color attach="background" args={['#0A0B0D']} />
            <ambientLight intensity={0.6} />
            <directionalLight position={[4, 4, 4]} intensity={1} />
            <PulseNode
              baseColor="#F7931A"
              position={[-2.1, 0, 0]}
              changePct={Number(btc?.change_pct_24h ?? 0)}
            />
            <PulseNode
              baseColor="#3B82F6"
              position={[0, 0, 0]}
              changePct={Number(eth?.change_pct_24h ?? 0)}
            />
            <PulseNode
              baseColor="#D4AF37"
              position={[2.1, 0, 0]}
              changePct={Number(gold?.change_pct_24h ?? 0)}
            />
          </Canvas>
        </div>

        <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-3 gap-3">
          {items.map(({ symbol, color, tick }) => {
            const pct = Number(tick?.change_pct_24h ?? 0);
            const pctClass =
              pct > 0 ? 'text-[#16C784]' : pct < 0 ? 'text-[#EA3943]' : 'text-[#8B92A0]';
            return (
              <div
                key={symbol}
                className="bg-[#0A0B0D] border border-[#22262E] rounded p-3 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono font-semibold" style={{ color }}>
                    {symbol}
                  </span>
                  <span className={`text-xs num-tabular ${pctClass}`}>
                    {tick ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '--'}
                  </span>
                </div>
                <div className="mt-2 text-lg font-semibold num-tabular text-white">
                  {tick ? `$${Number(tick.mark_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--'}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

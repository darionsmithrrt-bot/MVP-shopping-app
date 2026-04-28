import { useCallback, useEffect, useState } from "react";
import { supabase } from "../supabaseClient";

export const useRewards = ({ setError, setToast }) => {
  const [userPoints, setUserPoints] = useState(0);
  const [rewards, setRewards] = useState([]);

  const fetchRewards = useCallback(async () => {
    const { data, error } = await supabase
      .from("reward_catalog")
      .select("*")
      .eq("is_active", true)
      .order("points_cost", { ascending: true });

    if (error) {
      console.error("REWARDS LOAD ERROR:", error);
      return;
    }

    setRewards(data || []);
  }, []);

  const fetchUserPoints = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setUserPoints(0);
      return;
    }

    const { data, error } = await supabase
      .from("user_point_balances")
      .select("available_points")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("USER POINTS LOAD ERROR:", error);
      setUserPoints(0);
      return;
    }

    setUserPoints(Number(data?.available_points || 0));
  }, []);

  const handleRedeemReward = async (reward) => {
    const pointsCost = Number(reward?.points_cost || 0);

    if (!reward?.id) {
      return;
    }

    if (userPoints < pointsCost) {
      return;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return;
    }

    const { error: redemptionError } = await supabase
      .from("reward_redemptions")
      .insert([
        {
          user_id: user.id,
          reward_id: reward.id,
          points_spent: pointsCost,
        },
      ]);

    if (redemptionError) {
      console.error("REWARD REDEMPTION ERROR:", redemptionError);
      return;
    }

    const { error: pointsEventError } = await supabase
      .from("point_events")
      .insert([
        {
          user_id: user.id,
          event_type: "reward_redeemed",
          points: -pointsCost,
        },
      ]);

    if (pointsEventError) {
      console.error("REWARD POINT EVENT ERROR:", pointsEventError);
      return;
    }

    await fetchUserPoints();
    setToast({ message: "Reward redeemed!", type: "success" });
  };

  useEffect(() => {
    fetchRewards();
  }, [fetchRewards]);

  void setError;

  return {
    userPoints,
    rewards,
    fetchUserPoints,
    handleRedeemReward,
  };
};